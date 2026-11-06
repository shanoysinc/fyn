//! Decides what clipboard history may keep. Pure functions, so they're fully unit-tested.
//!
//! * [`Class::Never`]: known secret formats (API keys and tokens, private keys,
//!   credentials in URLs or `password=` lines, card numbers). Never stored anywhere.
//! * [`Class::Sensitive`]: text that *looks like* a generated password. Never kept either
//!   (not even in memory); the clipboard may be cleared after a minute.
//! * [`Class::Normal`]: everything else.
//!
//! Key formats follow the gitleaks rule set (MIT). Password detection is a heuristic:
//! it catches most generated passwords; word-based ones look like ordinary text and
//! can't be told apart by any tool.

use std::sync::OnceLock;

use regex::Regex;

/// Longest text clipboard history will keep (characters).
pub const MAX_CHARS: usize = 100_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Class {
    Normal,
    Sensitive,
    Never(&'static str),
}

pub fn classify(text: &str) -> Class {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Class::Never("empty");
    }
    if trimmed.chars().count() > MAX_CHARS {
        return Class::Never("too long");
    }
    if let Some(kind) = secret_kind(trimmed) {
        return Class::Never(kind);
    }
    if contains_card_number(trimmed) {
        return Class::Never("card number");
    }
    if looks_like_password(trimmed) {
        return Class::Sensitive;
    }
    Class::Normal
}

fn secret_patterns() -> &'static [(&'static str, Regex)] {
    static PATTERNS: OnceLock<Vec<(&'static str, Regex)>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        [
            ("private key", r"-----BEGIN[A-Z ]*PRIVATE KEY( BLOCK)?-----"),
            ("GitHub token", r"\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b"),
            ("GitHub token", r"\bgithub_pat_[A-Za-z0-9_]{50,}"),
            ("GitLab token", r"\bglpat-[A-Za-z0-9_-]{20,}"),
            ("API key", r"\bsk-(proj-|ant-[a-z0-9]+-)?[A-Za-z0-9_-]{20,}"), // OpenAI, Anthropic
            ("AWS key", r"\b(AKIA|ASIA)[0-9A-Z]{16}\b"),
            ("Stripe key", r"\b(sk|rk)_(live|test)_[0-9A-Za-z]{20,}"),
            ("Slack token", r"\bxox[abprs]-[0-9A-Za-z-]{10,}"),
            ("Google API key", r"\bAIza[0-9A-Za-z_-]{35}"),
            ("npm token", r"\bnpm_[A-Za-z0-9]{36}\b"),
            ("SendGrid key", r"\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}"),
            ("JWT", r"\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}"),
            // scheme://user:password@host (database URLs, basic auth)
            ("credentials in URL", r"\b[a-zA-Z][a-zA-Z0-9+.-]*://[^\s:/@]+:[^\s/@]+@"),
            // .env / config lines: PASSWORD=…, api_key: …, token = …
            (
                "password or key setting",
                // (?:^|[^a-z]) rather than \b so DATABASE_PASSWORD= matches too.
                r"(?i)(?:^|[^a-z])(password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)\b\s*[:=]\s*\S{6,}",
            ),
        ]
        .into_iter()
        .map(|(name, re)| (name, Regex::new(re).expect("valid secret pattern")))
        .collect()
    })
}

fn secret_kind(text: &str) -> Option<&'static str> {
    secret_patterns().iter().find(|(_, re)| re.is_match(text)).map(|(name, _)| *name)
}

/// 13–19 digits, optionally grouped by single spaces or dashes, passing the Luhn check.
fn contains_card_number(text: &str) -> bool {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"\b\d(?:[ -]?\d){12,18}\b").unwrap());
    re.find_iter(text).any(|m| {
        let digits: Vec<u32> = m.as_str().chars().filter_map(|c| c.to_digit(10)).collect();
        (13..=19).contains(&digits.len()) && luhn(&digits)
    })
}

fn luhn(digits: &[u32]) -> bool {
    let sum: u32 = digits
        .iter()
        .rev()
        .enumerate()
        .map(|(i, &d)| if i % 2 == 1 { let x = d * 2; if x > 9 { x - 9 } else { x } } else { d })
        .sum();
    sum % 10 == 0
}

/// Heuristic for generated passwords: one "word" of 8–64 characters mixing character
/// types with frequent switches between them, and none of the shapes that ordinary
/// tokens have (URLs, emails, paths, hashes, UUIDs, versions, colours, identifiers).
fn looks_like_password(text: &str) -> bool {
    let chars: Vec<char> = text.chars().collect();
    let n = chars.len();
    if !(8..=64).contains(&n) || chars.iter().any(|c| c.is_whitespace()) {
        return false;
    }
    if has_ordinary_shape(text) {
        return false;
    }

    let kind = |c: char| match c {
        'a'..='z' => 0,
        'A'..='Z' => 1,
        '0'..='9' => 2,
        _ => 3,
    };
    let mut classes = [false; 4];
    for &c in &chars {
        classes[kind(c)] = true;
    }
    if classes.iter().filter(|&&b| b).count() < 3 {
        return false;
    }

    // Random strings switch character type often; names and code mostly don't.
    let switches = chars.windows(2).filter(|w| kind(w[0]) != kind(w[1])).count();
    if (switches as f64) / ((n - 1) as f64) < 0.4 {
        return false;
    }

    // Runs of lower-case letters mean words: one long run ("Summer2024!",
    // "MyComponent_v2") or several short ones ("getUserName2").
    let mut run = 0;
    let mut word_runs = 0;
    for &c in chars.iter().chain(std::iter::once(&' ')) {
        if c.is_ascii_lowercase() {
            run += 1;
            if run >= 5 {
                return false;
            }
        } else {
            if run >= 3 {
                word_runs += 1;
            }
            run = 0;
        }
    }
    if word_runs >= 2 {
        return false;
    }

    shannon_entropy(&chars) >= 3.0
}

fn has_ordinary_shape(text: &str) -> bool {
    static RE: OnceLock<Vec<Regex>> = OnceLock::new();
    let res = RE.get_or_init(|| {
        [
            r"(?i)^[a-z][a-z0-9+.-]*://",                    // URL
            r"(?i)^www\.",                                     // URL without scheme
            r"^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$",                // email
            r"^([A-Za-z]:)?[\\/]",                             // path
            r"(?i)^[0-9a-f]{7,64}$",                           // hash / hex id
            r"(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", // UUID
            r"(?i)^v?\d+(\.\d+)+([-+][0-9a-z.-]+)?$",          // version
            r"(?i)^#[0-9a-f]{3,8}$",                           // colour
            r"^[\d\s+().,:/-]+$",                              // numbers, dates, phone numbers
        ]
        .into_iter()
        .map(|re| Regex::new(re).unwrap())
        .collect()
    });
    res.iter().any(|re| re.is_match(text))
}

/// Bits per character, from the string's own character frequencies.
fn shannon_entropy(chars: &[char]) -> f64 {
    let mut counts = std::collections::HashMap::new();
    for &c in chars {
        *counts.entry(c).or_insert(0usize) += 1;
    }
    let n = chars.len() as f64;
    counts.values().map(|&c| {
        let p = c as f64 / n;
        -p * p.log2()
    }).sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn never(text: &str) -> bool {
        matches!(classify(text), Class::Never(_))
    }

    #[test]
    fn known_secret_formats_are_never_kept() {
        for secret in [
            "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----",
            "-----BEGIN RSA PRIVATE KEY-----",
            "ghp_0123456789abcdefghijklmnopqrstuvwxyz",
            "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123456789abcdefghijklmnopqrstuvwx",
            "glpat-abcdefghij0123456789",
            "sk-proj-abcdefghijklmnopqrstuvwxyz012345",
            "sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345",
            "AKIAIOSFODNN7EXAMPLE",
            concat!("sk_live", "_51H8abcdefghijklmnopqrstuv"),
            "xoxb-1234567890-abcdefghij",
            "AIzaSyA-1234567890abcdefghijklmnopqrstu",
            "npm_abcdefghijklmnopqrstuvwxyz0123456789",
            "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
            "postgres://admin:hunter2@db.example.com:5432/app",
            "DATABASE_PASSWORD=correcthorse",
            "api_key: 9f8e7d6c5b4a",
            "export AUTH_TOKEN=abc123def456",
        ] {
            assert!(never(secret), "should never keep: {secret}");
        }
    }

    #[test]
    fn secrets_inside_longer_text_are_caught_too() {
        assert!(never("here's the key: AKIAIOSFODNN7EXAMPLE, don't share it"));
        assert!(never("ok\nPASSWORD=s3cretvalue\nPORT=8080"));
    }

    #[test]
    fn card_numbers_are_never_kept() {
        assert!(never("4111 1111 1111 1111")); // Visa test number
        assert!(never("5500-0000-0000-0004")); // Mastercard test number
        assert!(never("my card is 378282246310005 thanks")); // Amex test number
        // 16 digits that fail the Luhn check aren't a card (e.g. an order number).
        assert_eq!(classify("1234 5678 9012 3456"), Class::Normal);
    }

    #[test]
    fn generated_passwords_are_sensitive() {
        for pw in ["Tr0ub4dor&3", "kX9#mP2$vL7q", "gH7!q2Lz@9Wd", "x8Q-vR3+mN6&", "kX9mP2vL7qR4"] {
            assert_eq!(classify(pw), Class::Sensitive, "{pw}");
        }
    }

    #[test]
    fn ordinary_text_is_normal() {
        for text in [
            "hello world",
            "Meeting moved to 3pm",
            "https://github.com/shanoysinc/fyn",
            "www.example.com",
            "shanoy@example.com",
            r"C:\Users\shano\Documents",
            "getUserName2",
            "MyComponent_v2",
            "Summer2024!", // a human password; indistinguishable from text (documented limit)
            "550e8400-e29b-41d4-a716-446655440000",
            "a3f5c9e1b2",
            "v1.2.3-beta",
            "#7C3AED",
            "+1 (555) 123-4567",
            "2026-11-06",
            "const x = getValue(42);",
            "report_2024.pdf",
            "fn main() { println!(\"hi\"); }",
        ] {
            assert_eq!(classify(text), Class::Normal, "{text}");
        }
    }

    #[test]
    fn empty_and_huge_text_is_skipped() {
        assert!(never(""));
        assert!(never("   \n\t "));
        assert!(never(&"a ".repeat(MAX_CHARS)));
    }

    #[test]
    fn luhn_check() {
        assert!(luhn(&[4, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]));
        assert!(!luhn(&[4, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2]));
    }
}
