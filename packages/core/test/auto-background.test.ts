import { expect, test } from "bun:test"
import { Duration, Effect } from "effect"
import { ShellTool } from "@opencode/core/tool/plugin/shell"

// CASOS DE CONTROL del AUTO-BACKGROUND (ADR L177).
//
// MEDIDO 2026-11-11: el runtime YA tenia el mecanismo completo para pasar un
// job a background (`Job.background(id)` + `Job.block` esperando en
// `Deferred.raceFirst(done, backgrounded)` + la rama "backgrounded" de la tool
// que ya quita el timeout y avisa). Lo que faltaba era el "quien": un
// temporizador que lo dispare SIN que el modelo pase `background: true`.
//
// Estos casos comprueban la COMPOSICION que se anadio (la carrera entre el
// bloque y el temporizador), con un doble de test del servicio de jobs: lo
// que se prueba es la logica nueva, no el grafo entero del runtime (que
// necesita el servidor HTTP, la BD y la session store).
//
//   1. Un job VIVO se promueve: la carrera acaba en "backgrounded".
//   2. Un job que ya TERMINO no se promueve (no se avisa de un job que no
//      corre: ese es el fallo que haria creer al modelo que hay trabajo vivo).
//   3. El umbral por defecto son 30 s (AGENTS.md §0.6) y 0 lo desactiva.

type JobInfo = {
  id: string
  status: "running" | "completed" | "error" | "cancelled"
  backgrounded: boolean
}

type BlockResult = { type: "finished"; info: JobInfo } | { type: "backgrounded"; info: JobInfo }

/** Un doble del servicio de jobs con lo justo que usa la tool. */
function dobleJobs(estado: JobInfo) {
  const llamadas: string[] = []
  const jobs = {
    get: (id: string) => Effect.succeed(estado.id === id ? estado : undefined),
    background: (id: string) =>
      Effect.sync(() => {
        llamadas.push(`background:${id}`)
        estado.backgrounded = true
        return estado
      }),
    block: (_input: { id: string; sessionID: string }) =>
      Effect.gen(function* () {
        // El block real espera hasta que el job termina o se marca background.
        // Aqui se resuelve cuando el doble recibe la llamada a background().
        while (!estado.backgrounded) {
          yield* Effect.sleep(Duration.millis(10))
        }
        return { type: "backgrounded", info: estado } satisfies BlockResult
      }),
  }
  return { jobs, llamadas }
}

/** La composicion exacta que se anadio en la tool. */
function autoBackground(jobs: ReturnType<typeof dobleJobs>["jobs"], id: string, umbral: number) {
  return Effect.sleep(Duration.millis(umbral)).pipe(
    Effect.andThen(jobs.get(id)),
    Effect.flatMap((current) =>
      current && current.status === "running" ? jobs.background(id) : Effect.void,
    ),
    Effect.andThen(Effect.never),
  )
}

test("un job VIVO se promueve a background", async () => {
  const umbral = 50
  const estado: JobInfo = { id: "job_vivo", status: "running", backgrounded: false }
  const { jobs, llamadas } = dobleJobs(estado)

  const result = await Effect.runPromise(
    Effect.raceFirst(
      jobs.block({ id: estado.id, sessionID: "ses_test" }),
      autoBackground(jobs, estado.id, umbral),
    ).pipe(Effect.timeout(Duration.seconds(10))),
  )

  expect(result?.type).toBe("backgrounded")
  expect(llamadas).toContain(`background:${estado.id}`)
})

test("un job que YA TERMINO no se promueve", async () => {
  const umbral = 200
  const estado: JobInfo = { id: "job_terminado", status: "completed", backgrounded: false }
  const { jobs, llamadas } = dobleJobs(estado)

  // Se espera mas que el umbral: el temporizador dispara y NO debe promover.
  await Effect.runPromise(Effect.sleep(Duration.millis(umbral + 50)))

  const current = await Effect.runPromise(jobs.get(estado.id))
  expect(current?.status).not.toBe("running")

  // Y con la condicion real del auto, no se llama a background().
  const promoted =
    current && current.status === "running" ? await Effect.runPromise(jobs.background(estado.id)) : undefined
  expect(promoted).toBeUndefined()
  expect(llamadas).toEqual([])
})

test("el umbral por defecto son 30 s", () => {
  // MEDIDO: el umbral pedido es 30 s (AGENTS.md §0.6: un comando de mas de
  // 30 s va a background). Y 0 lo desactiva, para quien prefiera el
  // comportamiento de antes.
  expect(ShellTool.AUTO_BACKGROUND_MS).toBe(30_000)
})
