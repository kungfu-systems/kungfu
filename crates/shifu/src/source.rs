// SPDX-License-Identifier: Apache-2.0
//
// Exact, rootless source acquisition. This module intentionally stays std-only
// and never executes repository code. The repository-pinned ./shifu becomes
// the entrypoint only after a qualified checkout has been returned.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

const CONTRACT: &str = include_str!("../../../docs/shifu/source-contract.json");
const PLAN_SCHEMA: &str = include_str!("../../../docs/shifu/schema/source-plan-v1.schema.json");
const RECEIPT_SCHEMA: &str =
    include_str!("../../../docs/shifu/schema/source-receipt-v1.schema.json");
const GIT_REPOSITORY_ENVIRONMENT: [&str; 15] = [
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_CONFIG",
    "GIT_CONFIG_PARAMETERS",
    "GIT_CONFIG_COUNT",
    "GIT_OBJECT_DIRECTORY",
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_IMPLICIT_WORK_TREE",
    "GIT_GRAFT_FILE",
    "GIT_INDEX_FILE",
    "GIT_NO_REPLACE_OBJECTS",
    "GIT_REPLACE_REF_BASE",
    "GIT_PREFIX",
    "GIT_SHALLOW_FILE",
    "GIT_COMMON_DIR",
];

#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct Spec {
    repository: String,
    transport: String,
    commit: String,
    tree: String,
    tag: String,
    bundle_root: String,
    passport_root: String,
    destination: PathBuf,
    cache: String,
    resume: bool,
    partial: bool,
    sparse: Vec<String>,
}

fn json(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c < ' ' => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn list(values: &[String]) -> String {
    format!(
        "[{}]",
        values
            .iter()
            .map(|value| json(value))
            .collect::<Vec<_>>()
            .join(",")
    )
}

fn valid_hex(value: &str, length: usize) -> bool {
    value.len() == length && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn valid_root(value: &str) -> bool {
    value.is_empty()
        || (value.starts_with("sha256:")
            && value.len() == 71
            && value[7..]
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)))
}

fn valid_ref(value: &str) -> bool {
    !value.is_empty()
        && !value.starts_with('-')
        && !value.contains("..")
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-._/".contains(&byte))
}

fn valid_sparse(value: &str) -> bool {
    let path = Path::new(value);
    !value.is_empty()
        && !value.contains('\\')
        && !path.is_absolute()
        && !path
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
}

fn take(args: &[String], index: &mut usize, flag: &str) -> Result<String, String> {
    *index += 1;
    args.get(*index)
        .filter(|value| !value.is_empty())
        .cloned()
        .ok_or_else(|| format!("{flag} requires a value"))
}

fn parse(args: &[String], allow_execute: bool) -> Result<(Spec, bool), String> {
    let mut spec = Spec::default();
    let mut execute = false;
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--repository" => spec.repository = take(args, &mut index, "--repository")?,
            "--mirror" => spec.transport = take(args, &mut index, "--mirror")?,
            "--commit" => spec.commit = take(args, &mut index, "--commit")?.to_lowercase(),
            "--tree" => spec.tree = take(args, &mut index, "--tree")?.to_lowercase(),
            "--tag" => spec.tag = take(args, &mut index, "--tag")?,
            "--bundle-root" => spec.bundle_root = take(args, &mut index, "--bundle-root")?,
            "--passport-root" => spec.passport_root = take(args, &mut index, "--passport-root")?,
            "--destination" | "--checkout" => {
                let flag = args[index].clone();
                spec.destination = PathBuf::from(take(args, &mut index, &flag)?)
            }
            "--cache" => spec.cache = take(args, &mut index, "--cache")?,
            "--resume" => spec.resume = true,
            "--partial" => spec.partial = true,
            "--sparse" => spec.sparse.push(take(args, &mut index, "--sparse")?),
            "--execute" if allow_execute => execute = true,
            "--json" => {}
            value => return Err(format!("unknown source option: {value}")),
        }
        index += 1;
    }
    if spec.repository.is_empty() || spec.repository.starts_with('-') {
        return Err("--repository requires one explicit source locator".into());
    }
    if spec.transport.is_empty() {
        spec.transport = spec.repository.clone();
    }
    if spec.transport.starts_with('-') {
        return Err("--mirror must be a source locator, not an option".into());
    }
    if !valid_hex(&spec.commit, 40) || !valid_hex(&spec.tree, 40) {
        return Err("--commit and --tree must be exact 40-hex Git object ids".into());
    }
    if spec.destination.as_os_str().is_empty() {
        return Err("--destination is required".into());
    }
    if !spec.tag.is_empty() && !valid_ref(&spec.tag) {
        return Err("--tag is not a safe exact Git ref name".into());
    }
    if !valid_root(&spec.bundle_root) || !valid_root(&spec.passport_root) {
        return Err("bundle and passport roots must be sha256:<64 lowercase hex>".into());
    }
    if spec.sparse.iter().any(|value| !valid_sparse(value)) {
        return Err("--sparse paths must be repository-relative POSIX paths".into());
    }
    spec.sparse.sort();
    spec.sparse.dedup();
    Ok((spec, execute))
}

fn plan_core(spec: &Spec) -> String {
    format!(
        "{{\"schema\":\"shifu.source-plan/v1\",\"operation\":\"acquire\",\"readOnly\":true,\"requiresExecute\":true,\"repository\":{},\"transportLocator\":{},\"identity\":{{\"commit\":{},\"tree\":{},\"tag\":{},\"bundleRoot\":{},\"releasePassportRoot\":{}}},\"destination\":{{\"path\":{},\"collisionPolicy\":{},\"resume\":{}}},\"transfer\":{{\"cache\":{},\"partial\":{},\"sparse\":{}}},\"safety\":{{\"executesRepositoryCode\":false,\"autoBuild\":false,\"autoEdit\":false,\"autoClean\":false}},\"nextAction\":\"repeat as shifu source acquire with the same exact inputs and --execute\"}}",
        json(&spec.repository),
        json(&spec.transport),
        json(&spec.commit),
        json(&spec.tree),
        if spec.tag.is_empty() { "null".into() } else { json(&spec.tag) },
        if spec.bundle_root.is_empty() { "null".into() } else { json(&spec.bundle_root) },
        if spec.passport_root.is_empty() { "null".into() } else { json(&spec.passport_root) },
        json(&spec.destination.display().to_string()),
        json(if spec.resume { "resume-qualified-only" } else { "reject-existing" }),
        spec.resume,
        if spec.cache.is_empty() { "null".into() } else { json(&spec.cache) },
        spec.partial,
        list(&spec.sparse),
    )
}

fn plan(spec: &Spec) -> String {
    let core = plan_core(spec);
    let root = sha256(core.as_bytes());
    format!(
        "{}\n",
        core.strip_suffix('}').unwrap().to_string() + &format!(",\"planRoot\":\"sha256:{root}\"}}")
    )
}

fn git_command() -> Result<Command, String> {
    let git = crate::util::find_on_path("git")
        .ok_or_else(|| "git is required for source acquisition".to_string())?;
    let mut command = Command::new(git);
    // Git exports repository-local variables to hooks. Acquisition may run
    // under such a hook, so never let an ambient GIT_DIR/GIT_INDEX_FILE retarget
    // the exact destination selected by this command.
    for key in GIT_REPOSITORY_ENVIRONMENT {
        command.env_remove(key);
    }
    command
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env(
            "GIT_CONFIG_GLOBAL",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
        )
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_LFS_SKIP_SMUDGE", "1")
        .arg("-c")
        .arg("core.hooksPath=");
    Ok(command)
}

fn run_git(args: &[String]) -> Result<Output, String> {
    let output = git_command()?
        .args(args)
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("failed to run git: {error}"))?;
    if output.status.success() {
        Ok(output)
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

fn git_text(destination: &Path, args: &[&str]) -> Result<String, String> {
    let mut full = vec!["-C".to_string(), destination.display().to_string()];
    full.extend(args.iter().map(|value| value.to_string()));
    Ok(String::from_utf8_lossy(&run_git(&full)?.stdout)
        .trim()
        .to_string())
}

fn ensure_destination(spec: &Spec) -> Result<bool, String> {
    if spec.destination.exists() {
        if !spec.resume {
            return Err("destination already exists; collisionPolicy=reject-existing".into());
        }
        if !spec.destination.join(".git").is_dir() {
            return Err("resume requires an existing non-bare Git checkout".into());
        }
        let origin = git_text(&spec.destination, &["remote", "get-url", "origin"])?;
        if origin != spec.repository && origin != spec.transport {
            return Err("resume origin does not match repository or declared mirror".into());
        }
        return Ok(true);
    }
    if let Some(parent) = spec
        .destination
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
    {
        if !parent.exists() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("cannot create destination parent: {error}"))?;
        }
    }
    let init = vec![
        "init".to_string(),
        "--template=".to_string(),
        spec.destination.display().to_string(),
    ];
    run_git(&init)?;
    git_text(
        &spec.destination,
        &["remote", "add", "origin", &spec.transport],
    )?;
    Ok(false)
}

fn verify(spec: &Spec) -> Result<(String, String), String> {
    if !spec.destination.join(".git").is_dir() {
        return Err("checkout does not contain a Git worktree".into());
    }
    let commit = git_text(&spec.destination, &["rev-parse", "HEAD^{commit}"])?;
    let tree = git_text(&spec.destination, &["rev-parse", "HEAD^{tree}"])?;
    if commit != spec.commit {
        return Err(format!(
            "source commit mismatch: expected {}, got {commit}",
            spec.commit
        ));
    }
    if tree != spec.tree {
        return Err(format!(
            "source tree mismatch: expected {}, got {tree}",
            spec.tree
        ));
    }
    let origin = git_text(&spec.destination, &["remote", "get-url", "origin"])?;
    if origin != spec.repository {
        return Err("qualified checkout origin does not match repository identity".into());
    }
    if !spec.tag.is_empty() {
        let tag_commit = git_text(
            &spec.destination,
            &["rev-parse", &format!("refs/tags/{}^{{commit}}", spec.tag)],
        )?;
        if tag_commit != spec.commit {
            return Err("declared tag does not resolve to the exact commit".into());
        }
    }
    Ok((commit, tree))
}

fn receipt(spec: &Spec, status: &str, commit: &str, tree: &str) -> String {
    let plan_root = format!("sha256:{}", sha256(plan_core(spec).as_bytes()));
    let core = format!(
        "{{\"schema\":\"shifu.source-receipt/v1\",\"status\":{},\"planRoot\":{},\"repository\":{},\"transportLocator\":{},\"checkout\":{},\"identity\":{{\"commit\":{},\"tree\":{},\"tag\":{},\"bundleRoot\":{},\"releasePassportRoot\":{}}},\"executionEntrypoint\":\"./shifu\",\"repositoryCodeExecuted\":false}}",
        json(status), json(&plan_root), json(&spec.repository), json(&spec.transport),
        json(&spec.destination.display().to_string()), json(commit), json(tree),
        if spec.tag.is_empty() { "null".into() } else { json(&spec.tag) },
        if spec.bundle_root.is_empty() { "null".into() } else { json(&spec.bundle_root) },
        if spec.passport_root.is_empty() { "null".into() } else { json(&spec.passport_root) },
    );
    let root = sha256(core.as_bytes());
    format!(
        "{}\n",
        core.strip_suffix('}').unwrap().to_string()
            + &format!(",\"receiptRoot\":\"sha256:{root}\"}}")
    )
}

fn acquire(spec: &Spec) -> Result<String, String> {
    let resumed = ensure_destination(spec)?;
    if !resumed && !spec.cache.is_empty() {
        let cache = PathBuf::from(&spec.cache);
        let objects = if cache.join("objects").is_dir() {
            cache.join("objects")
        } else {
            cache.join(".git").join("objects")
        };
        if !objects.is_dir() {
            return Err("--cache must name a bare repository or Git checkout".into());
        }
        let objects = objects
            .canonicalize()
            .map_err(|error| format!("cannot resolve cache object store: {error}"))?;
        let alternates = spec.destination.join(".git/objects/info/alternates");
        fs::create_dir_all(alternates.parent().unwrap())
            .map_err(|error| format!("cannot prepare cache binding: {error}"))?;
        fs::write(&alternates, format!("{}\n", objects.display()))
            .map_err(|error| format!("cannot bind cache object store: {error}"))?;
    }
    // A mirror is transport only. Resume may find the qualified repository
    // identity in origin, so switch to the declared transport for fetch and
    // restore the repository identity before qualification.
    if spec.transport != spec.repository {
        git_text(
            &spec.destination,
            &["remote", "set-url", "origin", &spec.transport],
        )?;
    }
    let has_commit = git_text(
        &spec.destination,
        &["cat-file", "-e", &format!("{}^{{commit}}", spec.commit)],
    )
    .is_ok();
    if !has_commit {
        let mut fetch = vec![
            "-C".into(),
            spec.destination.display().to_string(),
            "fetch".into(),
            "--no-tags".into(),
            "--depth=1".into(),
        ];
        if spec.partial {
            fetch.push("--filter=blob:none".into());
        }
        fetch.extend(["origin".into(), spec.commit.clone()]);
        run_git(&fetch)?;
    }
    if !spec.tag.is_empty() {
        let refspec = format!("refs/tags/{0}:refs/tags/{0}", spec.tag);
        let mut fetch = vec![
            "-C".into(),
            spec.destination.display().to_string(),
            "fetch".into(),
            "--depth=1".into(),
        ];
        if spec.partial {
            fetch.push("--filter=blob:none".into());
        }
        fetch.extend(["origin".into(), refspec]);
        run_git(&fetch)?;
    }
    if !spec.sparse.is_empty() {
        git_text(&spec.destination, &["sparse-checkout", "init", "--cone"])?;
        let mut sparse = vec![
            "-C".into(),
            spec.destination.display().to_string(),
            "sparse-checkout".into(),
            "set".into(),
        ];
        sparse.extend(spec.sparse.clone());
        run_git(&sparse)?;
    }
    git_text(&spec.destination, &["checkout", "--detach", &spec.commit])?;
    if spec.transport != spec.repository {
        git_text(
            &spec.destination,
            &["remote", "set-url", "origin", &spec.repository],
        )?;
    }
    let (commit, tree) = verify(spec)?;
    Ok(receipt(spec, "qualified", &commit, &tree))
}

fn diagnostic(message: &str) -> String {
    format!("{{\"schema\":\"shifu.source-diagnosis/v1\",\"ok\":false,\"code\":\"source-verification-failed\",\"message\":{},\"repositoryCodeExecuted\":false}}\n", json(message))
}

fn usage() -> ! {
    eprintln!("usage: shifu source contract|schema <plan|receipt>|plan OPTIONS|acquire OPTIONS --execute|verify OPTIONS\nrequired OPTIONS: --repository URL --commit SHA --tree SHA --destination PATH\noptional: --tag TAG --bundle-root ROOT --passport-root ROOT --mirror URL --cache PATH --resume --partial --sparse PATH --json");
    std::process::exit(2)
}

pub fn run(args: &[String]) -> ! {
    match args {
        [verb] if verb == "contract" => print!("{CONTRACT}"),
        [verb, kind] if verb == "schema" && kind == "plan" => print!("{PLAN_SCHEMA}"),
        [verb, kind] if verb == "schema" && kind == "receipt" => print!("{RECEIPT_SCHEMA}"),
        [verb, rest @ ..] if verb == "plan" => match parse(rest, false) {
            Ok((spec, _)) => print!("{}", plan(&spec)),
            Err(error) => {
                print!("{}", diagnostic(&error));
                std::process::exit(2);
            }
        },
        [verb, rest @ ..] if verb == "acquire" => match parse(rest, true) {
            Ok((spec, true)) => match acquire(&spec) {
                Ok(value) => print!("{value}"),
                Err(error) => {
                    print!("{}", diagnostic(&error));
                    std::process::exit(1);
                }
            },
            Ok(_) => {
                print!("{}", diagnostic("source acquire requires --execute"));
                std::process::exit(2);
            }
            Err(error) => {
                print!("{}", diagnostic(&error));
                std::process::exit(2);
            }
        },
        [verb, rest @ ..] if verb == "verify" => match parse(rest, false) {
            Ok((spec, _)) => match verify(&spec) {
                Ok((commit, tree)) => print!("{}", receipt(&spec, "qualified", &commit, &tree)),
                Err(error) => {
                    print!("{}", diagnostic(&error));
                    std::process::exit(1);
                }
            },
            Err(error) => {
                print!("{}", diagnostic(&error));
                std::process::exit(2);
            }
        },
        _ => usage(),
    }
    std::process::exit(0)
}

// Compact SHA-256 keeps plan/receipt roots cross-platform without adding a
// dependency or writing temporary files during read-only planning.
fn sha256(input: &[u8]) -> String {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];
    let mut data = input.to_vec();
    let bit_len = (data.len() as u64) * 8;
    data.push(0x80);
    while data.len() % 64 != 56 {
        data.push(0);
    }
    data.extend_from_slice(&bit_len.to_be_bytes());
    let mut h = [
        0x6a09e667u32,
        0xbb67ae85,
        0x3c6ef372,
        0xa54ff53a,
        0x510e527f,
        0x9b05688c,
        0x1f83d9ab,
        0x5be0cd19,
    ];
    let (chunks, []) = data.as_chunks::<64>() else {
        unreachable!("SHA-256 padding must produce complete blocks");
    };
    for chunk in chunks {
        let mut w = [0u32; 64];
        let (words, []) = chunk.as_chunks::<4>() else {
            unreachable!("SHA-256 blocks divide into complete words");
        };
        for (index, word) in words.iter().enumerate() {
            w[index] = u32::from_be_bytes(*word);
        }
        for index in 16..64 {
            let s0 = w[index - 15].rotate_right(7)
                ^ w[index - 15].rotate_right(18)
                ^ (w[index - 15] >> 3);
            let s1 = w[index - 2].rotate_right(17)
                ^ w[index - 2].rotate_right(19)
                ^ (w[index - 2] >> 10);
            w[index] = w[index - 16]
                .wrapping_add(s0)
                .wrapping_add(w[index - 7])
                .wrapping_add(s1);
        }
        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh] = h;
        for index in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let t1 = hh
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[index])
                .wrapping_add(w[index]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let t2 = s0.wrapping_add(maj);
            hh = g;
            g = f;
            f = e;
            e = d.wrapping_add(t1);
            d = c;
            c = b;
            b = a;
            a = t1.wrapping_add(t2);
        }
        for (state, value) in h.iter_mut().zip([a, b, c, d, e, f, g, hh]) {
            *state = state.wrapping_add(value);
        }
    }
    h.iter().map(|word| format!("{word:08x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_matches_the_public_vector() {
        assert_eq!(
            sha256(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn plan_is_content_addressed_and_read_only() {
        let commit = "a".repeat(40);
        let tree = "b".repeat(40);
        let args = [
            "--repository",
            "https://example.test/kungfu.git",
            "--commit",
            commit.as_str(),
            "--tree",
            tree.as_str(),
            "--destination",
            "kungfu",
        ];
        let owned = args
            .iter()
            .map(|value| value.to_string())
            .collect::<Vec<_>>();
        let (spec, execute) = parse(&owned, false).unwrap();
        let output = plan(&spec);
        assert!(!execute);
        assert!(output.contains("\"readOnly\":true"));
        assert!(output.contains("\"requiresExecute\":true"));
        assert!(output.contains("\"planRoot\":\"sha256:"));
    }

    #[test]
    fn unsafe_refs_and_inexact_objects_fail_closed() {
        let args = vec![
            "--repository".into(),
            "repo".into(),
            "--commit".into(),
            "main".into(),
            "--tree".into(),
            "tree".into(),
            "--destination".into(),
            "out".into(),
        ];
        assert!(parse(&args, false).is_err());
    }

    #[test]
    fn release_roots_require_canonical_lowercase_hex() {
        let args = vec![
            "--repository".into(),
            "repo".into(),
            "--commit".into(),
            "a".repeat(40),
            "--tree".into(),
            "b".repeat(40),
            "--bundle-root".into(),
            format!("sha256:{}", "A".repeat(64)),
            "--destination".into(),
            "out".into(),
        ];
        assert!(parse(&args, false).is_err());
    }
}
