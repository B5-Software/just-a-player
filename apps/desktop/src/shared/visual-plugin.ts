/** Portable shader data, never JavaScript or access to the application bridge. */
export interface VisualPlugin {
  apiVersion: 1
  id: string
  name: string
  author: string
  license: string
  description: string
  fragment: string
}
export function parseVisualPlugin(value: unknown): VisualPlugin {
  if (!value || typeof value !== 'object') throw Error('效果插件必须是 JSON 对象')
  const v = value as Record<string, unknown>
  if (v.apiVersion !== 1 || typeof v.id !== 'string' || !/^[a-z][a-z0-9-]{1,63}$/.test(v.id))
    throw Error('插件需要 apiVersion: 1 和有效的 id')
  for (const key of ['name', 'author', 'license', 'description', 'fragment'])
    if (
      typeof v[key] !== 'string' ||
      !(v[key] as string).trim() ||
      (v[key] as string).length > (key === 'fragment' ? 32768 : 300)
    )
      throw Error(`插件字段 ${key} 无效`)
  if (/^\s*#\s*(include|version|extension)\b|\bvoid\s+main\s*\(/m.test(v.fragment as string))
    throw Error('插件仅提供 vec3 visualize(vec2 uv)，不能替换入口或加载外部代码')
  return {
    apiVersion: 1,
    id: v.id,
    name: v.name as string,
    author: v.author as string,
    license: v.license as string,
    description: v.description as string,
    fragment: v.fragment as string,
  }
}
