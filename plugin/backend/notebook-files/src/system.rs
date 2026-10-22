/// First non-blank of USER, USERNAME, LOGNAME (trimmed). Pure: the lookup is injected so tests never touch process env.
pub fn user_from(get: impl Fn(&str) -> Option<String>) -> Option<String> {
    ["USER", "USERNAME", "LOGNAME"].iter().find_map(|k| {
        let v = get(k)?;
        let t = v.trim();
        if t.is_empty() { None } else { Some(t.to_string()) }
    })
}

pub fn current_user() -> Option<String> {
    user_from(|k| std::env::var(k).ok())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let m: HashMap<String, String> = pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        move |k| m.get(k).cloned()
    }

    #[test]
    fn user_from_prefers_user_over_username() {
        assert_eq!(user_from(env(&[("USER", "a"), ("USERNAME", "b"), ("LOGNAME", "c")])), Some("a".into()));
    }

    #[test]
    fn user_from_falls_back_to_username_then_logname() {
        assert_eq!(user_from(env(&[("USERNAME", "b"), ("LOGNAME", "c")])), Some("b".into()));
        assert_eq!(user_from(env(&[("LOGNAME", "c")])), Some("c".into()));
    }

    #[test]
    fn user_from_skips_empty_and_whitespace() {
        assert_eq!(user_from(env(&[("USER", ""), ("USERNAME", "  \t"), ("LOGNAME", " c ")])), Some("c".into()));
    }

    #[test]
    fn user_from_returns_none_when_all_missing() {
        assert_eq!(user_from(env(&[])), None);
        assert_eq!(user_from(env(&[("USER", " ")])), None);
    }

    #[test]
    fn user_from_keeps_cjk_and_spaces() {
        assert_eq!(user_from(env(&[("USER", "张 三")])), Some("张 三".into()));
    }
}
