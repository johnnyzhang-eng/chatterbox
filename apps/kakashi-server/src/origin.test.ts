import { describe, expect, test } from 'bun:test'

import { isLoopbackHost, isOriginAllowed } from './origin'

describe('isOriginAllowed', () => {
  test('accepts live rooms and non-browser clients', () => {
    expect(isOriginAllowed('https://live.bilibili.com')).toBe(true)
    expect(isOriginAllowed(null)).toBe(true)
  })

  test('rejects other sites, opaque origins and extensions unless allowed explicitly', () => {
    expect(isOriginAllowed('https://evil.example')).toBe(false)
    expect(isOriginAllowed('https://www.bilibili.com')).toBe(false)
    expect(isOriginAllowed('null')).toBe(false)
    expect(isOriginAllowed('chrome-extension://abc')).toBe(false)
    expect(isOriginAllowed('chrome-extension://abc', ['chrome-extension://abc'])).toBe(true)
  })
})

test('isLoopbackHost only matches this machine', () => {
  expect(isLoopbackHost('127.0.0.1')).toBe(true)
  expect(isLoopbackHost('::1')).toBe(true)
  expect(isLoopbackHost('0.0.0.0')).toBe(false)
  expect(isLoopbackHost('192.168.1.2')).toBe(false)
})
