import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { readCreativeSkillResource } from './loader'
import {
  CREATIVE_DOMAIN_OUTPUT_KIND,
  creativeOutputJsonSchema,
  readCreativeOutputDefinition,
} from './output-registry'
import { getCreativeSkillDefinition } from './registry'
import type { CreativeDomainKind, CreativeOutputKind, CreativeSkillId } from './types'

type ProfessionalSkillId = Exclude<CreativeSkillId, 'creative-core'>

export type CreativeRuntimeSkillDefinition = {
  readonly kind: CreativeDomainKind
  readonly title: string
  readonly description: string
  readonly skillIds: readonly ['creative-core', ProfessionalSkillId]
  readonly outputKind: CreativeOutputKind
  readonly executionFacts: string | null
}

function defineRuntimeSkill(
  definition: Omit<CreativeRuntimeSkillDefinition, 'outputKind'>,
): CreativeRuntimeSkillDefinition {
  return {
    ...definition,
    outputKind: CREATIVE_DOMAIN_OUTPUT_KIND[definition.kind],
  }
}

export const CREATIVE_RUNTIME_SKILL_REGISTRY: Readonly<
  Record<CreativeDomainKind, CreativeRuntimeSkillDefinition>
> = {
  script: defineRuntimeSkill({
    kind: 'script',
    title: '内容与脚本开发',
    description: '创作或修改项目的源文本——故事剧本、商业广告脚本、品牌或企业宣传脚本、播放量导向的短视频脚本——并形成 screenplay 专业结果（screenplayText 承载任一形态的源文本）。',
    skillIds: ['creative-core', 'script-development'],
    executionFacts: null,
  }),
  direction: defineRuntimeSkill({
    kind: 'direction',
    title: '创作方向',
    description: '建立项目级呈现方向，并形成 creative_direction 专业结果。',
    skillIds: ['creative-core', 'creative-direction'],
    executionFacts: null,
  }),
  assets: defineRuntimeSkill({
    kind: 'assets',
    title: '资产范围与视觉设计',
    description: '筛选和设计生产资产，形成带最终图片提示词的 asset_generation_batch 专业结果。',
    skillIds: ['creative-core', 'asset-development'],
    executionFacts: 'The image model is fixed in settings; omit model identity and obey the current create_image tool schema. Fill required exposed options; omit options.aspectRatio for reusable assets (character/location/prop) — the server applies the fixed 4:3 asset format. Fixed parameters are absent and supplied by the server. Every asset includes its stable creative identity, complete final prompt and user-visible name. The server owns Resource placement.',
  }),
  video: defineRuntimeSkill({
    kind: 'video',
    title: '视频导演与生成设计',
    description: '完成视频导演、分段和最终视频提示词，形成 video_generation_batch 专业结果。',
    skillIds: ['creative-core', 'video-direction'],
    executionFacts: 'The video model is fixed in settings; omit model identity and obey the current create_video tool schema’s duration and reference limits. Fill its exposed options; fixed parameters are absent and supplied by the server. Input mode is derived from reference roles. Never guess capability limits.',
  }),
  music: defineRuntimeSkill({
    kind: 'music',
    title: '音乐与配乐设计',
    description: '从内容与真实时间线规划配乐窗口并创作 Composition Plan，形成 audio_generation_batch 专业结果。',
    skillIds: ['creative-core', 'music-direction'],
    executionFacts: 'The music model is fixed in settings; omit model identity and obey the current create_audio tool schema’s Composition Plan limits. Plan duration is the sum of chunk durations; output format is fixed MP3. Never guess capability limits.',
  }),
}

export const CREATIVE_RUNTIME_SKILLS: readonly CreativeRuntimeSkillDefinition[] = Object.values(
  CREATIVE_RUNTIME_SKILL_REGISTRY,
)

/** Pinned Codex system Skills stay disabled. A Codex upgrade that adds one fails smoke. */
export const PRIMARY_AGENT_DISABLED_NATIVE_SKILL_IDS = [
  'imagegen',
  'openai-docs',
  'plugin-creator',
  'review-agent',
  'skill-creator',
  'skill-installer',
] as const

const PRIMARY_AGENT_RUNTIME_BOOTSTRAP = `# Wao runtime

The developer instructions are the authoritative project policy. Native Wao Skills provide the professional method and strict output schema for each matching result. Runtime scratch is never a project Resource.`

function tomlString(value: string): string {
  return JSON.stringify(value)
}

function withoutFrontmatter(content: string): string {
  const normalized = content.replace(/^\uFEFF/u, '')
  const match = normalized.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/u)
  if (!match) throw new Error('CREATIVE_SKILL_FRONTMATTER_REQUIRED')
  return normalized.slice(match[0].length).trim()
}

async function buildRuntimeSkill(skill: CreativeRuntimeSkillDefinition): Promise<string> {
  const outputDefinition = readCreativeOutputDefinition(skill.outputKind)
  if (
    outputDefinition.domainKind !== skill.kind
    || outputDefinition.professionalSkillId !== skill.skillIds[1]
  ) {
    throw new Error(`CREATIVE_RUNTIME_SKILL_OUTPUT_REGISTRY_MISMATCH:${skill.kind}`)
  }
  const resources = await Promise.all(skill.skillIds.map(async (skillId) => {
    const definition = getCreativeSkillDefinition(skillId)
    const resource = await readCreativeSkillResource({ uri: definition.entryUri })
    return {
      definition,
      checksum: resource.checksum,
      body: withoutFrontmatter(resource.content),
    }
  }))
  const professionalSkillId = skill.skillIds[1]
  const professionalDefinition = getCreativeSkillDefinition(professionalSkillId)
  const jsonSchema = JSON.stringify(creativeOutputJsonSchema(skill.outputKind), null, 2)
  return [
    '---',
    `name: ${professionalSkillId}`,
    `description: ${JSON.stringify(professionalDefinition.summary)}`,
    '---',
    '',
    `# ${skill.title}`,
    '',
    'Use this Skill only when the current request matches this professional domain.',
    'You are the primary Wao Agent and the sole author of this professional result. This Skill owns only its declared domain and outputKind; complete this result from its contract instead of importing another domain method into it.',
    `Construct exactly one object with outputKind=${JSON.stringify(skill.outputKind)} during this Turn. The object is the single professional result: use it directly in the response, pass its exact media items to the matching Wao Operation, or save it only when the user explicitly requests persistence.`,
    'Never invent project paths or Resource identities. Use only canonical Resource ids and versions supplied by Wao tools or current context. Runtime scratch has no delivery meaning.',
    skill.executionFacts,
    ...resources.map(({ definition, checksum, body }) => [
      `<wao_skill_source id=${JSON.stringify(definition.id)} version=${JSON.stringify(definition.version)} checksum=${JSON.stringify(checksum)}>`,
      body,
      '</wao_skill_source>',
    ].join('\n')),
    'The professional object must match the authoritative schema below exactly: include every required field, include no unknown field, and never invent fields from prose examples. Media item fields are the same contract consumed by the corresponding generation Operation.',
    `<wao_output_schema outputKind=${JSON.stringify(skill.outputKind)}>`,
    jsonSchema,
    '</wao_output_schema>',
  ].filter((value): value is string => value !== null).join('\n\n')
}

export async function materializeCreativeRuntimeConfiguration(
  codexHomeDirectory: string,
  runtimeSkillsDirectory: string,
): Promise<void> {
  const skillsDirectory = runtimeSkillsDirectory
  await mkdir(skillsDirectory, { recursive: true, mode: 0o700 })
  // Earlier runtimes installed Wao Skills in Codex home. That made native
  // Skill reads look like workspace-external shell access under on-request
  // approval. These registry-owned files are regenerated for every placement;
  // remove only their exact old directories so there is one discoverable copy.
  await Promise.all(CREATIVE_RUNTIME_SKILLS.map(async (skill) => {
    await rm(
      path.join(codexHomeDirectory, 'skills', skill.skillIds[1]),
      { recursive: true, force: true },
    )
  }))
  await Promise.all(CREATIVE_RUNTIME_SKILLS.map(async (skill) => {
    const professionalSkillId = skill.skillIds[1]
    const skillDirectory = path.join(skillsDirectory, professionalSkillId)
    await mkdir(skillDirectory, { recursive: true, mode: 0o700 })
    await writeFile(
      path.join(skillDirectory, 'SKILL.md'),
      `${await buildRuntimeSkill(skill)}\n`,
      { mode: 0o600 },
    )
  }))
  const disabledSkills = PRIMARY_AGENT_DISABLED_NATIVE_SKILL_IDS.flatMap((skillId) => [
    '[[skills.config]]',
    // `~` resolves through this process's CODEX_HOME on both drivers. A host
    // absolute path is invalid inside Docker and would silently leave the
    // bundled system Skill enabled there.
    `path = ${tomlString(path.join('~', 'skills', '.system', skillId, 'SKILL.md'))}`,
    'enabled = false',
    '',
  ])
  await Promise.all([
    writeFile(
      path.join(codexHomeDirectory, 'AGENTS.md'),
      `${PRIMARY_AGENT_RUNTIME_BOOTSTRAP.trim()}\n`,
      { mode: 0o600 },
    ),
    writeFile(
      path.join(codexHomeDirectory, 'config.toml'),
      [
        '[agents]',
        'enabled = false',
        '',
        disabledSkills.join('\n'),
        '',
      ].join('\n'),
      { mode: 0o600 },
    ),
  ])
}

export function creativeSkillRoutingInstructions(): readonly string[] {
  return CREATIVE_RUNTIME_SKILLS.map((skill) => {
    const mediaOperationId = readCreativeOutputDefinition(skill.outputKind).mediaOperationId
    const execution = mediaOperationId === null
      ? 'text result, saved only through save_project_document on explicit request'
      : `pass exact items to ${mediaOperationId}`
    return `${skill.kind} -> native Skill ${skill.skillIds[1]}, outputKind=${skill.outputKind}, execution: ${execution}: ${skill.description}`
  })
}
