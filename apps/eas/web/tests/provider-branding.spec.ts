import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import {
  PROVIDER_ICONS,
  providerIconSpec,
} from '../lib/provider-branding'

const root = path.resolve(process.cwd(), '..')
const asset = (file: string) => path.join(root, 'web/public/provider-icons', file)

describe('provider branding', () => {
  it('covers every branded provider in all service registries', () => {
    const llm = readFileSync(path.join(root, 'eas/services/provider_registry.py'), 'utf8')
    const services = readFileSync(path.join(root, 'eas/services/config/provider_runtime.py'), 'utf8')
    const ids = new Set([
      ...Array.from(llm.matchAll(/name="([a-z_]+)"/g), m => m[1]),
      ...Array.from(services.matchAll(/^    "([a-z_]+)": \w+ProviderSpec\(/gm), m => m[1]),
    ])
    // Y-API has no verified official brand asset; retain the generic fallback.
    const generic = new Set(['none', 'custom', 'custom_anthropic', 'custom_openai_sdk', 'custom_chat', 'y_api'])
    expect(ids.size).toBeGreaterThan(50)
    for (const id of ids) {
      if (generic.has(id)) expect(providerIconSpec(id), id).toBeUndefined()
      else expect(providerIconSpec(id), id).toBeDefined()
    }
  })

  it('ships every referenced asset, including dark variants, without external SVG content', () => {
    for (const spec of Object.values(PROVIDER_ICONS)) {
      for (const file of [spec.file, spec.darkFile].filter(Boolean) as string[]) {
        expect(existsSync(asset(file)), file).toBe(true)
        const content = readFileSync(asset(file))
        expect(content.length, file).toBeGreaterThan(100)
        if (file.endsWith('.svg')) {
          const svg = content.toString()
          expect(svg).toContain('<svg')
          expect(svg).not.toMatch(/<script|<foreignObject|\bon\w+=|(?:href|src)=["']https?:/i)
        }
      }
    }
  })

  it('resolves legacy aliases but leaves unknown custom brands generic', () => {
    expect(providerIconSpec(' workbuddy ')).toEqual(providerIconSpec('codebuddy'))
    expect(providerIconSpec('atlas_cloud')).toEqual(providerIconSpec('atlascloud'))
    for (const id of ['my-gateway', '__proto__', 'constructor', '', null]) {
      expect(providerIconSpec(id)).toBeUndefined()
    }
  })


})
