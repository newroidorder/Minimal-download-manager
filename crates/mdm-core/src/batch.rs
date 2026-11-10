//! "Add batch download": http://site/img*.jpg with * from 1 to 20 (optionally
//! zero-padded) or from a to z.

const MAX: i64 = 10_000;

fn letter(s: &str) -> Option<char> {
    let mut it = s.chars();
    match (it.next(), it.next()) {
        (Some(c), None) if c.is_ascii_alphabetic() => Some(c),
        _ => None,
    }
}

fn int(s: &str) -> Option<i64> {
    let t = s.trim();
    let d: String = t.chars().enumerate().take_while(|(i, c)| c.is_ascii_digit() || (*i == 0 && *c == '-')).map(|(_, c)| c).collect();
    d.parse().ok()
}

pub fn expand(pattern: &str, from: &str, to: &str, width: usize) -> Result<Vec<String>, String> {
    if !pattern.contains('*') {
        return Err("the address must contain *".into());
    }
    let values: Vec<String> = if let (Some(a), Some(b)) = (letter(from), letter(to)) {
        if a.is_ascii_lowercase() != b.is_ascii_lowercase() {
            return Err("use the same letter case for both ends".into());
        }
        let (a, b) = (a as u8, b as u8);
        if a <= b { (a..=b).map(|c| (c as char).to_string()).collect() } else { (b..=a).rev().map(|c| (c as char).to_string()).collect() }
    } else {
        let (Some(a), Some(b)) = (int(from), int(to)) else { return Err("use numbers (0 or more) or single letters".into()) };
        if a < 0 || b < 0 {
            return Err("use numbers (0 or more) or single letters".into());
        }
        if (b - a).abs() + 1 > MAX {
            return Err(format!("at most {MAX} files"));
        }
        let fmt = |n: i64| format!("{n:0width$}");
        if a <= b { (a..=b).map(fmt).collect() } else { (b..=a).rev().map(fmt).collect() }
    };
    Ok(values.iter().map(|v| pattern.replace('*', v)).collect())
}

#[cfg(test)]
mod tests {
    use super::expand;

    #[test]
    fn numbers_letters_padding() {
        assert_eq!(expand("u/*.jpg", "8", "10", 2).unwrap(), ["u/08.jpg", "u/09.jpg", "u/10.jpg"]);
        assert_eq!(expand("*", "c", "a", 0).unwrap(), ["c", "b", "a"]);
        assert!(expand("*", "a", "C", 0).is_err());
        assert!(expand("x", "1", "2", 0).is_err());
        assert!(expand("*", "0", "10000", 0).is_err());
    }
}
