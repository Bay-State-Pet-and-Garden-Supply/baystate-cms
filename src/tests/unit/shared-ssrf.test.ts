import { describe, expect, it } from 'vitest';
import { classifyIp, isPrivateOrLinkLocal } from '../../shared/ssrf';

describe('shared ssrf classifier', () => {
  it('classifies loopback as private (verbatim legacy behavior)', () => {
    expect(classifyIp('127.0.0.1')).toBe('private');
    expect(classifyIp('::1')).toBe('link_local');
    expect(classifyIp('::')).toBe('link_local');
  });

  it('classifies RFC1918 ranges as private', () => {
    expect(classifyIp('10.1.2.3')).toBe('private');
    expect(classifyIp('172.16.0.1')).toBe('private');
    expect(classifyIp('172.31.255.255')).toBe('private');
    expect(classifyIp('192.168.1.1')).toBe('private');
  });

  it('classifies link-local ranges', () => {
    expect(classifyIp('169.254.169.254')).toBe('link_local');
    expect(classifyIp('fe80::1')).toBe('private');
  });

  it('handles octal, hex, and integer IPv4 representations', () => {
    // 127.0.0.1 variants
    expect(classifyIp('0177.0.0.1')).toBe('private');
    expect(classifyIp('0x7f000001')).toBe('private');
    expect(classifyIp('2130706433')).toBe('private');
    expect(classifyIp('127.1')).toBe('private');
    // 10.0.0.1 variant
    expect(classifyIp('012.0.0.1')).toBe('private');
    // 169.254.169.254 integer variant (2852038142)
    expect(classifyIp('2852038142')).toBe('link_local');
  });

  it('handles ::ffff:-mapped IPv4', () => {
    expect(classifyIp('::ffff:127.0.0.1')).toBe('private');
    expect(classifyIp('::ffff:7f00:1')).toBe('private');
    expect(classifyIp('::ffff:0177.0.0.1')).toBe('private');
    expect(classifyIp('::ffff:192.168.0.5')).toBe('private');
    expect(classifyIp('::ffff:8.8.8.8')).toBe('public');
  });

  it('classifies public addresses', () => {
    expect(classifyIp('8.8.8.8')).toBe('public');
    expect(classifyIp('2606:4700::1111')).toBe('public');
  });

  it('returns unknown for garbage input', () => {
    expect(classifyIp('not-an-ip')).toBe('unknown');
    expect(classifyIp('999.1.1.1')).toBe('unknown');
    expect(classifyIp('')).toBe('unknown');
  });
});

describe('isPrivateOrLinkLocal', () => {
  it('blocks private and link-local, allows public', () => {
    expect(isPrivateOrLinkLocal('127.0.0.1')).toBe(true);
    expect(isPrivateOrLinkLocal('0177.0.0.1')).toBe(true);
    expect(isPrivateOrLinkLocal('2130706433')).toBe(true);
    expect(isPrivateOrLinkLocal('10.0.0.7')).toBe(true);
    expect(isPrivateOrLinkLocal('169.254.1.1')).toBe(true);
    expect(isPrivateOrLinkLocal('8.8.8.8')).toBe(false);
  });
});
