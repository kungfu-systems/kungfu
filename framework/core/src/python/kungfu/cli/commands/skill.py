# SPDX-License-Identifier: Apache-2.0

"""Stable Click facade for the responsibility-owned Skill command domains."""

from kungfu.cli.commands._skill.base import (
    _default_skill_audit_log as _default_skill_audit_log,
    _extra_paths as _extra_paths,
    _skill_json as _skill_json,
    _json_file as _json_file,
    skill as skill,
    skill_command_context as skill_command_context,
)
from kungfu.cli.commands._skill.authoring import (
    _authoring_error as _authoring_error,
    author as author,
    author_catalog_cmd as author_catalog_cmd,
    author_contract_cmd as author_contract_cmd,
    author_inspect_cmd as author_inspect_cmd,
    author_qualify_cmd as author_qualify_cmd,
    author_scaffold_cmd as author_scaffold_cmd,
)
from kungfu.cli.commands._skill.lifecycle import (
    _keyed_paths as _keyed_paths,
    _mutation_options as _mutation_options,
    _mutation_result as _mutation_result,
    _run_mutation as _run_mutation,
    _simple_mutation_command as _simple_mutation_command,
    admit as admit,
    contract_cmd as contract_cmd,
    diagnose as diagnose,
    diff_cmd as diff_cmd,
    enable_cmd as enable_cmd,
    history as history,
    inspect as inspect,
    install as install,
    invoke_cmd as invoke_cmd,
    load_cmd as load_cmd,
    remove_cmd as remove_cmd,
    retire_cmd as retire_cmd,
    rollback as rollback,
    schema_cmd as schema_cmd,
    select as select,
    suspend_cmd as suspend_cmd,
    update as update,
    validate as validate,
)
from kungfu.cli.commands._skill.runtime import (
    _bundle_audit_path as _bundle_audit_path,
    _node_context_script as _node_context_script,
    _repo_root as _repo_root,
    _skill_context_env as _skill_context_env,
    _verify_response_text as _verify_response_text,
    _write_envelope_file as _write_envelope_file,
    _write_node_envelope_file as _write_node_envelope_file,
    audit as audit,
    catalog as catalog,
    context as context,
    deps as deps,
    explain as explain,
    list_skills as list_skills,
    read as read,
    runtime_audit as runtime_audit,
    verify as verify,
)


def _json(data):
    return _skill_json(data)


_COMMAND_SYMBOLS = (
    "skill author author_contract_cmd author_catalog_cmd author_inspect_cmd "
    "author_scaffold_cmd author_qualify_cmd contract_cmd schema_cmd validate "
    "install update enable_cmd load_cmd invoke_cmd suspend_cmd retire_cmd "
    "remove_cmd select rollback admit inspect history diagnose diff_cmd "
    "list_skills catalog context verify read audit runtime_audit deps explain"
).split()
for _symbol in _COMMAND_SYMBOLS:
    _callback = globals()[_symbol].callback
    _callback.__module__ = __name__
    _callback.__qualname__ = _callback.__name__


_FUNCTION_SYMBOLS = (
    "_json _extra_paths _repo_root _node_context_script _write_envelope_file "
    "_skill_context_env _json_file _keyed_paths _write_node_envelope_file "
    "_default_skill_audit_log _bundle_audit_path _verify_response_text "
    "_authoring_error _mutation_result _run_mutation _mutation_options "
    "_simple_mutation_command"
).split()
for _symbol in _FUNCTION_SYMBOLS:
    globals()[_symbol].__module__ = __name__
    globals()[_symbol].__qualname__ = _symbol
