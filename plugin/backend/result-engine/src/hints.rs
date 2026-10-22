/// Replaces string literals, quoted identifiers and comments with spaces.
fn blank(sql: &str) -> Vec<char> {
    let c: Vec<char> = sql.chars().collect();
    let mut out = Vec::with_capacity(c.len());
    let mut i = 0;
    while i < c.len() {
        match c[i] {
            q @ ('\'' | '"' | '`') => {
                i += 1;
                while i < c.len() {
                    if c[i] == q {
                        if i + 1 < c.len() && c[i + 1] == q {
                            i += 2;
                            continue;
                        }
                        break;
                    }
                    i += 1;
                }
                i += 1;
                out.push(' ');
            }
            '[' => {
                while i < c.len() && c[i] != ']' {
                    i += 1;
                }
                i += 1;
                out.push(' ');
            }
            '-' if c.get(i + 1) == Some(&'-') => {
                while i < c.len() && c[i] != '\n' {
                    i += 1;
                }
                out.push(' ');
            }
            '/' if c.get(i + 1) == Some(&'*') => {
                i += 2;
                while i < c.len() && !(c[i] == '*' && c.get(i + 1) == Some(&'/')) {
                    i += 1;
                }
                i += 2;
                out.push(' ');
            }
            ch => {
                out.push(ch);
                i += 1;
            }
        }
    }
    out
}

#[derive(PartialEq)]
enum Tok {
    Word(String),
    Sym(char),
    Cast,
}

fn tokenize(chars: &[char]) -> Vec<Tok> {
    let mut toks = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let ch = chars[i];
        if ch.is_whitespace() {
            i += 1;
        } else if ch.is_alphanumeric() || ch == '_' || ch == '$' {
            let s = i;
            while i < chars.len() && (chars[i].is_alphanumeric() || chars[i] == '_' || chars[i] == '$') {
                i += 1;
            }
            toks.push(Tok::Word(chars[s..i].iter().collect::<String>().to_ascii_uppercase()));
        } else if ch == ':' && chars.get(i + 1) == Some(&':') {
            toks.push(Tok::Cast);
            i += 2;
        } else {
            toks.push(Tok::Sym(ch));
            i += 1;
        }
    }
    toks
}

/// Suggests a Postgres-to-SQLite rewrite rule code for a failed query.
pub fn dialect_hint(sql: &str, err: &str) -> Option<&'static str> {
    let e = err.to_ascii_lowercase();
    if ["timed out", "interrupted", "no such table", "session is full"].iter().any(|p| e.contains(p)) {
        return None;
    }
    let toks = tokenize(&blank(sql));
    let word = |i: usize, w: &str| matches!(toks.get(i), Some(Tok::Word(x)) if x == w);
    let any = |f: &dyn Fn(usize) -> bool| (0..toks.len()).any(f);

    if toks.contains(&Tok::Cast) {
        Some("cast_operator")
    } else if any(&|i| word(i, "ILIKE")) {
        Some("ilike")
    } else if any(&|i| word(i, "DISTINCT") && word(i + 1, "ON")) {
        Some("distinct_on")
    } else if any(&|i| word(i, "FILTER") && toks.get(i + 1) == Some(&Tok::Sym('('))) {
        Some("filter_clause")
    } else if any(&|i| word(i, "WITHIN") && word(i + 1, "GROUP")) {
        Some("within_group")
    } else if toks.contains(&Tok::Sym('~')) {
        Some("regex_operator")
    } else {
        None
    }
}
