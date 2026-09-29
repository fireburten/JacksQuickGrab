// Finds sensitive text in OCR'd lines for Smart Redact and the check before sharing: email
// addresses, phone numbers, card numbers (Luhn-checked), IP addresses, keys and tokens, US
// Social Security numbers and IBANs (checksum-verified). Checks are deliberately picky, so
// dates, times, version numbers and ordinary long words aren't flagged.
// Classic script (window.RedactDetect) that also loads in Node for tests.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RedactDetect = api;
})(typeof self !== 'undefined' ? self : this, function () {
  // One and many, as whole phrases so translations can word them their own way.
  const LABELS = {
    email: ['1 email address', '{n} email addresses'],
    phone: ['1 phone number', '{n} phone numbers'],
    card: ['1 card number', '{n} card numbers'],
    ip: ['1 IP address', '{n} IP addresses'],
    secret: ['1 key or password', '{n} keys or passwords'],
    ssn: ['1 Social Security number', '{n} Social Security numbers'],
    iban: ['1 bank account number', '{n} bank account numbers'],
  };
  const fill = (text, vars) => (vars ? text.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : text);

  const digitsOf = s => s.replace(/\D/g, '');

  function luhn(digits) {
    let sum = 0;
    for (let i = 0; i < digits.length; i++) {
      let d = +digits[digits.length - 1 - i];
      if (i % 2) { d *= 2; if (d > 9) d -= 9; }
      sum += d;
    }
    return sum % 10 === 0;
  }

  function ibanValid(raw) {
    const s = raw.replace(/\s/g, '').toUpperCase();
    if (s.length < 15 || s.length > 34) return false;
    const moved = (s.slice(4) + s.slice(0, 4)).replace(/[A-Z]/g, c => String(c.charCodeAt(0) - 55));
    let rem = 0;
    for (const ch of moved) rem = (rem * 10 + +ch) % 97;
    return rem === 1;
  }

  const looksLikeDate = s => /^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$/.test(s) || /^\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}$/.test(s);
  const IPV4 = /(?<![\d.])(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}(?![\d.])/g;

  // Each rule: kind, a global regex, an optional check on the match, and optionally which
  // capture group is the sensitive part (e.g. only the value after "password:").
  const RULES = [
    { kind: 'secret', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
    { kind: 'secret', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
    { kind: 'secret', re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b/g },
    { kind: 'secret', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g },
    { kind: 'secret', re: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
    { kind: 'secret', re: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/g },
    { kind: 'secret', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
    { kind: 'secret', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
    // "password: hunter2", "API key = abc123…": just the value.
    { kind: 'secret', re: /\b(?:api[ _-]?key|secret(?:[ _-]?key)?|access[ _-]?token|auth[ _-]?token|token|password|passwd|pwd|passcode|bearer)\b["']?\s*[:=]\s*["']?([^\s"',;]{4,})/gi, group: 1 },
    // A long random-looking string: letters and digits mixed, many different characters.
    {
      kind: 'secret', re: /(?<![\w/.-])[A-Za-z0-9_-]{32,}(?![\w/.-])/g,
      check: s => /\d.*\d/.test(s) && /[a-z]/i.test(s) && new Set(s).size >= 14 && !/^[0-9a-f]{40}$/i.test(s),   // not a git commit
    },
    { kind: 'email', re: /[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/gi },
    { kind: 'ssn', re: /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g },
    { kind: 'iban', re: /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){2,7}(?:\s?[A-Z0-9]{1,3})?\b/g, check: ibanValid },
    {
      kind: 'card', re: /(?<![\d-])(?:\d[ -]?){12,18}\d(?![\d-])/g,
      check: s => { const d = digitsOf(s); return d.length >= 13 && d.length <= 19 && luhn(d) && !/^(\d)\1+$/.test(d); },
    },
    { kind: 'ip', re: IPV4, check: s => s !== '0.0.0.0' },
    {
      kind: 'ip', re: /(?<![\w:])(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}(?![\w:])|(?<![\w:])(?:[0-9a-f]{1,4}:){1,6}:(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,5})?(?![\w:])/gi,
      check: s => /[a-f]/i.test(s) || s.includes('::'),   // not a time like 12:30:45
    },
    {
      kind: 'phone', re: /(?<![\w.+])(?:\+\d{1,3}[\s.-]?)?(?:\(\d{1,4}\)[\s.-]?)?\d{2,4}(?:[\s.-]?\d{2,5}){1,4}(?![\w.])/g,
      check: s => {
        const d = digitsOf(s);
        if (d.length < 10 || d.length > 15 || looksLikeDate(s.trim())) return false;
        if (d.length >= 13 && luhn(d)) return false;     // a card number: the card rule has it
        if (!/[\s().+-]/.test(s) && !s.startsWith('+')) return d.length <= 11;   // bare digit runs: only phone-length
        return true;
      },
    },
  ];

  // Non-overlapping findings, in reading order: [{ kind, start, end, text }].
  function detect(text) {
    const found = [];
    for (const rule of RULES) {
      rule.re.lastIndex = 0;
      for (const m of String(text).matchAll(rule.re)) {
        const part = rule.group ? m[rule.group] : m[0];
        if (!part || (rule.check && !rule.check(part))) continue;
        const start = m.index + (rule.group ? m[0].indexOf(part) : 0);
        const end = start + part.length;
        if (found.some(f => start < f.end && end > f.start)) continue;   // an earlier (stronger) rule has it
        found.push({ kind: rule.kind, start, end, text: part });
      }
    }
    return found.sort((a, b) => a.start - b.start);
  }

  // "2 email addresses and 1 card number"; tr (JPi18n.t) translates the phrases.
  function describe(findings, tr = fill) {
    const counts = new Map();
    findings.forEach(f => counts.set(f.kind, (counts.get(f.kind) || 0) + 1));
    const parts = [...counts].map(([kind, n]) => tr(LABELS[kind][n === 1 ? 0 : 1], { n }));
    if (parts.length < 2) return parts[0] || '';
    return tr('{list} and {last}', { list: parts.slice(0, -1).join(', '), last: parts[parts.length - 1] });
  }

  return { detect, describe, luhn, ibanValid };
});
