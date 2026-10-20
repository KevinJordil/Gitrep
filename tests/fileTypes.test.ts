import { describe, expect, it } from 'vitest'
import { fileKind, langFor, STATUS } from '../src/renderer/src/fileTypes'

describe('fileKind', () => {
  it('recognizes files by extension, case-insensitively', () => {
    const cases: [string, string][] = [
      ['src/main.c', 'c'], ['inc/util.h', 'h'], ['a/b.CPP', 'cpp'], ['x.hpp', 'hpp'], ['App.java', 'java'], ['build.gradle.kts', 'kotlin'],
      ['index.js', 'js'], ['main.ts', 'ts'], ['View.jsx', 'jsx'], ['View.tsx', 'tsx'], ['tool.py', 'python'], ['main.go', 'go'], ['lib.rs', 'rust'],
      ['run.sh', 'shell'], ['package.json', 'json'], ['ci.yml', 'yaml'], ['Cargo.toml', 'toml'], ['pom.xml', 'xml'], ['index.html', 'html'],
      ['site.scss', 'css'], ['schema.sql', 'sql'], ['README.md', 'markdown'], ['notes.txt', 'text'], ['doc.rst', 'text'], ['guide.adoc', 'text'],
      ['cmake/deps.cmake', 'cmake'], ['logo.png', 'image'], ['icon.svg', 'image'], ['manual.pdf', 'pdf'], ['dist.tar.gz', 'archive'], ['yarn.lock', 'lock']
    ]
    for (const [path, kind] of cases) expect(fileKind(path), path).toBe(kind)
  })

  it('recognizes special names before extensions', () => {
    const cases: [string, string][] = [
      ['CMakeLists.txt', 'cmake'], ['sub/Makefile', 'make'], ['Dockerfile', 'docker'], ['Dockerfile.dev', 'docker'], ['.gitignore', 'git'],
      ['LICENSE', 'license'], ['LICENSE.md', 'license'], ['package-lock.json', 'lock'], ['go.sum', 'lock']
    ]
    for (const [path, kind] of cases) expect(fileKind(path), path).toBe(kind)
  })

  it('falls back to a generic file, also for folders and names without extension', () => {
    expect(fileKind('bin/tool')).toBe('file')
    expect(fileKind('data.xyz')).toBe('file')
    expect(fileKind('untracked/dir/')).toBe('file')
  })
})

describe('fileKind edge cases', () => {
  it('ignores inherited object keys and maps the extra kinds', () => {
    for (const p of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', 'src/x.constructor', 'x.toString']) expect(fileKind(p), p).toBe('file')
    expect(fileKind('.bashrc')).toBe('file')
    expect(fileKind('LICENSE-MIT')).toBe('license')
    const cases: [string, string][] = [['a.gradle', 'groovy'], ['Jenkinsfile', 'groovy'], ['a.properties', 'ini'], ['a.ini', 'ini'], ['.env', 'env'], ['.env.local', 'env'],
      ['.dockerignore', 'config'], ['.editorconfig', 'config'], ['a.cs', 'csharp'], ['a.rb', 'ruby'], ['a.php', 'php'], ['a.swift', 'swift'], ['a.vue', 'vue']]
    for (const [p, k] of cases) expect(fileKind(p), p).toBe(k)
    expect(langFor('a.vue')).toBe('vue')
  })
})

describe('langFor', () => {
  it('gives the grammar of a file, null for files without one', () => {
    expect(langFor('a.c')).toBe('c')
    expect(langFor('a.h')).toBe('cpp')
    expect(langFor('CMakeLists.txt')).toBe('cmake')
    expect(langFor('Dockerfile')).toBe('dockerfile')
    expect(langFor('run.sh')).toBe('shellscript')
    expect(langFor('notes.txt')).toBeNull()
    expect(langFor('logo.png')).toBeNull()
  })
})

describe('STATUS', () => {
  it('maps git statuses to the badge letters', () => {
    expect(Object.fromEntries(Object.entries(STATUS).map(([k, s]) => [k, s.letter]))).toEqual({ A: 'A', C: 'A', M: 'M', T: 'M', D: 'D', R: 'R', '?': 'U', U: '!' })
    expect(STATUS['?'].title).toBe('Untracked')
    expect(STATUS.U.title).toBe('Conflicted')
  })
})
