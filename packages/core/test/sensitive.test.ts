import { describe, expect, it } from 'vitest';
import { findSensitive, flagsOf, groupSensitive, keepFlaggedMoments, luhn, matchSensitive, neighbourFlag, withTakeFlags, type EditOp, type TextLine } from '../src';

// Every value below is made up for the test. None is a real credential, card or phone number.
const cats = (text: string) => matchSensitive(text).map((m) => m.category);
const spans = (text: string) => matchSensitive(text).map((m) => text.slice(m.start, m.end));

describe('sensitive text patterns', () => {
  it('finds email addresses and nothing around them', () => {
    expect(spans('Send it to sam.rivera+demo@example-mail.test today')).toEqual(['sam.rivera+demo@example-mail.test']);
    expect(cats('twitter @cutaway and a@b')).toEqual([]);
    // as text recognition sometimes returns it
    expect(spans('Contact: sam.rivera@ example-mail.test')).toEqual(['sam.rivera@ example-mail.test']);
    expect(cats('ping @cutaway.app about it')).toEqual([]);
  });

  it('finds keys by their issuer prefix', () => {
    expect(cats('OPENAI sk-FAKEfake0000FAKEfake1111')).toEqual(['api-key']);
    expect(cats('stripe sk_test_FAKE0000fake1111FAKE')).toEqual(['api-key']);
    expect(cats('ghp_FAKEfake0000FAKEfake1111FAKEfake2222')).toEqual(['api-key']);
    expect(cats('aws AKIAFAKEFAKEFAKE0000 region us-east-1')).toEqual(['api-key']);
    expect(cats('Authorization: Bearer FAKEfake0000FAKEfake1111')).toEqual(['api-key']);
    expect(cats('eyJGQUtFIjoiZmFrZSJ9.eyJmYWtlIjoiZmFrZSJ9.FAKEsignature00')).toEqual(['api-key']);
    expect(cats('-----BEGIN RSA PRIVATE KEY-----')).toEqual(['api-key']);
  });

  it('hides the value after a password or key label, not the label', () => {
    expect(spans('password: Tr0ub4dor-fake')).toEqual(['Tr0ub4dor-fake']);
    expect(cats('password: Tr0ub4dor-fake')).toEqual(['password']);
    expect(spans('API_KEY="fake-value-1234"')).toEqual(['fake-value-1234']);
    expect(cats('client_secret = notARealSecret99')).toEqual(['password']);
    // already masked, or a form placeholder
    expect(cats('Password: ••••••••')).toEqual([]);
    expect(cats('password: required')).toEqual([]);
    expect(cats('Enter your password below')).toEqual([]);
  });

  it('finds card numbers only when the check digit is valid', () => {
    expect(luhn('4242424242424242')).toBe(true);
    expect(cats('Card 4242 4242 4242 4242 exp 12/30')).toEqual(['card-number']);
    expect(cats('Card 4242-4242-4242-4242')).toEqual(['card-number']);
    expect(cats('Order 4242 4242 4242 4243')).toEqual([]);
    expect(cats('0000 0000 0000 0000')).toEqual([]);
  });

  it('finds phone numbers but not dates, versions or plain counts', () => {
    expect(cats('Call +1 (555) 010-0199 now')).toEqual(['phone']);
    expect(cats('Call 555-010-0199')).toEqual(['phone']);
    expect(cats('+44 20 7946 0958')).toEqual(['phone']);
    expect(cats('2026-11-13 10:42:07')).toEqual([]);
    expect(cats('version 14.2.1 build 20261113')).toEqual([]);
    expect(cats('1920 x 1080 at 60 fps')).toEqual([]);
  });

  it('finds long random strings without a known prefix, but not hashes, words or URLs', () => {
    expect(cats('token aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0xR')).toEqual(['api-key']);
    expect(cats('commit 3f2a9c1e8b7d6f5a4c3b2a1908f7e6d5c4b3a291')).toEqual([]);
    expect(cats('https://example.test/a/very/long/path/WithMixedCase123')).toEqual([]);
    expect(cats('TheQuickBrownFoxJumpsOverTheLazyDog')).toEqual([]);
  });

  it('ordinary interface text is left alone', () => {
    for (const t of ['File Edit View Window Help', 'Total: 1,234.56 USD', 'Step 3 of 12', 'Tokens are cached for 60 minutes', 'Reset password', 'npm install --save-dev vitest@3.0.0']) expect(cats(t)).toEqual([]);
  });
});

describe('sensitive boxes', () => {
  const line: TextLine = {
    text: 'email sam@example.test ok',
    box: { x: 0.1, y: 0.2, w: 0.5, h: 0.04 },
    tokens: [
      { start: 0, end: 5, box: { x: 0.1, y: 0.2, w: 0.1, h: 0.04 } },
      { start: 6, end: 22, box: { x: 0.22, y: 0.2, w: 0.3, h: 0.04 } },
      { start: 23, end: 25, box: { x: 0.54, y: 0.2, w: 0.06, h: 0.04 } },
    ],
  };

  it('covers only the piece that matched', () => {
    const hits = findSensitive(line);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.category).toBe('email');
    expect(hits[0]!.box.x).toBeCloseTo(0.22, 9);
    expect(hits[0]!.box.w).toBeCloseTo(0.3, 9);
    expect(hits[0]!.box.h).toBeCloseTo(0.04, 9);
    // a hit carries a category and a box, never the text
    expect(Object.keys(hits[0]!).sort()).toEqual(['box', 'category']);
  });

  it('falls back to a proportional slice of the line when piece boxes are unknown', () => {
    const [hit] = findSensitive({ text: line.text, box: line.box });
    expect(hit!.box.x).toBeCloseTo(0.1 + (0.5 * 6) / 25, 5);
    expect(hit!.box.w).toBeCloseTo((0.5 * 16) / 25, 5);
  });

  it('joins a thing that stays put into one finding and splits when it moves or disappears', () => {
    const box = { x: 0.2, y: 0.3, w: 0.2, h: 0.03 };
    const moved = { x: 0.2, y: 0.6, w: 0.2, h: 0.03 };
    const frames = [
      { t: 0, hits: [] },
      { t: 1, hits: [{ category: 'email' as const, box }] },
      { t: 2, hits: [{ category: 'email' as const, box: { ...box, x: 0.201 } }] },
      { t: 3, hits: [{ category: 'email' as const, box }] },
      { t: 4, hits: [{ category: 'email' as const, box: moved }] },
      { t: 5, hits: [] },
      { t: 6, hits: [] },
      { t: 7, hits: [{ category: 'email' as const, box }] },
    ];
    const found = groupSensitive(frames, { interval: 1, duration: 7.5 });
    expect(found.map((f) => [f.start, f.end, f.frames])).toEqual([
      [0, 4, 3],
      [3, 5, 1],
      [6, 7.5, 1],
    ]);
    // padded, and still inside the frame
    expect(found[0]!.rect.x).toBeLessThan(0.2);
    expect(found[0]!.rect.w).toBeGreaterThan(0.2);
    expect(found.every((f) => f.rect.x >= 0 && f.rect.x + f.rect.w <= 1)).toBe(true);
  });
});

describe('recording flags', () => {
  it('adds a take once, sorted, and finds neighbours', () => {
    const p0 = { duration: 30, flags: undefined };
    const p1 = withTakeFlags(p0, 'take-001', [12.5, 3, Number.NaN, -1]);
    expect(flagsOf(p1).map((f) => f.t)).toEqual([3, 12.5]);
    expect(withTakeFlags(p1, 'take-001', [20])).toBe(p1);
    expect(neighbourFlag(p1.flags!, 3, 1)?.t).toBe(12.5);
    expect(neighbourFlag(p1.flags!, 12.5, 1)).toBeNull();
    expect(neighbourFlag(p1.flags!, 12.5, -1)?.t).toBe(3);
  });

  it('a flagged moment survives automatic cuts', () => {
    const ops: EditOp[] = [
      { op: 'cut', start: 1, end: 2, kind: 'silence' },
      { op: 'cut', start: 4, end: 9, kind: 'silence' },
      { op: 'cut', start: 11.8, end: 12.4, kind: 'filler' },
      { op: 'zoom', start: 5, end: 7, scale: 1.8 },
    ];
    const r = keepFlaggedMoments(ops, [6, 12]);
    expect(r.protectedCount).toBe(2);
    expect(r.ops).toEqual([
      { op: 'cut', start: 1, end: 2, kind: 'silence' },
      { op: 'cut', start: 4, end: 5.6, kind: 'silence' },
      { op: 'cut', start: 6.4, end: 9, kind: 'silence' },
      { op: 'zoom', start: 5, end: 7, scale: 1.8 },
    ]);
    expect(keepFlaggedMoments(ops, []).ops).toBe(ops);
  });
});
