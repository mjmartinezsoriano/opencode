export * as SkillInstructions from "./instructions.js"

import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Context, Effect, Layer, Schema } from "effect"
import { Permission } from "../permission.js"
import { Skill } from "../skill.js"
import { Instructions } from "../instructions/index.js"

const Summary = Schema.Struct({
  id: Skill.ID,
  name: Skill.Name,
  description: Schema.String,
})
type Summary = typeof Summary.Type

/**
 * MEDIDO 2026-11-17 (ADR L190): el catalogo de skills es el BLOQUE MAS CARO del
 * prompt real (10.208 tokens = 43,5 % del system; ADR L188/L189). El markup de
 * 5 lineas por skill costaba 6.364 chars (1.591 tok) para decir exactamente lo
 * mismo que 1 linea. Cero perdida de informacion:
 *   - el <name> solo se escribe cuando difiere del <id>: MEDIDO, 72 de 74
 *     skills tienen name == id (los 2 que no: opencode/OpenCode, report/Report)
 *   - la <description> sigue siendo TEXTO DE ELEMENTO (como antes): MEDIDO, 26
 *     descripciones contienen comillas dobles y 2 contienen '<', que como
 *     atributo habria que escapar (y el modelo leeria el escapado, no el texto)
 */
const escapeAttr = (value: string) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;")

const entries = (skills: ReadonlyArray<Summary>) =>
  skills.map((skill) =>
    [
      `  <skill id="${escapeAttr(skill.id)}"`,
      skill.name === skill.id ? "" : ` name="${escapeAttr(skill.name)}"`,
      `>${skill.description}</skill>`,
    ].join(""),
  )

const render = (skills: ReadonlyArray<Summary>) =>
  [
    "Skills provide specialized instructions and workflows for specific tasks.",
    "Use the skill tool to load a skill when a task matches its description.",
    "The user may also invoke a skill directly. When that happens, its instructions appear in the conversation as a <skill_content> block, the same shape the skill tool returns. A skill that is already present this way does not need to be invoked again.",
    ...(skills.length === 0
      ? ["No skills are currently available."]
      : ["<available_skills>", ...entries(skills), "</available_skills>"]),
  ].join("\n")

const update = Instructions.listUpdate<Summary>({
  key: (skill) => skill.id,
  changed: (before, after) => before.name !== after.name || before.description !== after.description,
  entries,
  render,
  text: {
    replaced: "The available skills have changed. This list supersedes the previous available skills list.",
    added: "New skills are available in addition to those previously listed:",
    changed: "The following skills have changed. Each entry replaces the previously listed skill with the same ID:",
    removed: (ids) => `The following skill IDs are no longer available and must not be used: ${ids}.`,
  },
})

export interface Interface {
  /** Lists skills the given ruleset does not deny; callers pass the merged agent and Session permissions. */
  readonly load: (permissions: Permission.Ruleset) => Effect.Effect<Instructions.List>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SkillInstructions") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const skills = yield* Skill.Service

    return Service.of({
      load: Effect.fn("SkillInstructions.load")(function* (permissions) {
        const available = Skill.available(yield* skills.list(), permissions)
          .flatMap((skill) =>
            skill.description === undefined || skill.autoinvoke === false
              ? []
              : [{ id: skill.id, name: skill.name, description: skill.description }],
          )
          .toSorted((a, b) => a.id.localeCompare(b.id))
        return Instructions.make<ReadonlyArray<Summary>>({
          key: Instructions.Key.make("core/skill-guidance"),
          codec: Schema.toCodecJson(Schema.Array(Summary)),
          read: Effect.succeed(available.length === 0 ? Instructions.removed : available),
          render: {
            initial: render,
            changed: update,
            removed: () => "Skill guidance is no longer available. Do not use any previously listed skill.",
          },
        })
      }),
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [Skill.node] })
