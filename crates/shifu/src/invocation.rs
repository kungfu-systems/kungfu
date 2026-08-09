// SPDX-License-Identifier: Apache-2.0

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InvocationMode {
    Standalone,
    EmbeddedKungfu,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct InvocationContext {
    pub mode: InvocationMode,
}

impl InvocationContext {
    pub const fn standalone() -> Self {
        Self {
            mode: InvocationMode::Standalone,
        }
    }

    pub const fn embedded_kungfu() -> Self {
        Self {
            mode: InvocationMode::EmbeddedKungfu,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::InvocationContext;

    #[test]
    fn embedded_version_evidence_names_the_invocation_mode() {
        let line = crate::version_line(None, InvocationContext::embedded_kungfu());
        assert!(line.contains("embedded in kungfu"));
        assert!(line.starts_with("shifu "));
    }
}
