# opencode-tmp maintenance

Procedimiento canónico para mantener el fork local de opencode (`fix-showthinking-thinking`) sincronizado con `anomalyco/opencode@dev`.

## Estado actual (snapshot)

```
Rama:      fix-showthinking-thinking
Remotes:   origin  = https://github.com/anomalyco/opencode.git
           fork    = https://github.com/mjmartinezsoriano/opencode.git
HEAD:      ef17facef9 (2026-08-14)
Ahead of origin/dev:  3 commits
Behind origin/dev:    0 commits
Working tree:         clean
```

**Los 3 commits ahead** son exclusivos del fork — todos tocan el camino MiniMax-M3 o el toggle TUI:

| SHA | Mensaje |
|---|---|
| `ef17facef9` | fix(session): use findLast for plan-mode detection in reminders |
| `2dba8f0fb5` | feat(opencode): parse inline think tags as reasoning parts |
| `3472f7438e` | fix(tui): make thinking toggle actually control visibility |

**Binario activo**: `C:\Users\mario\Desktop\Automatizaciones\opencode-tmp\packages\opencode\dist\opencode-windows-x64\bin\opencode.exe` (version string `0.0.0-fix-showthinking-thinking-<timestamp>`).

## Por qué un fork (no upstream oficial)

- `2dba8f0fb5` parsea `<think>...</think>` inline del modelo `minimax/MiniMax-M3` (endpoint OpenAI-compatible) como `reasoning` part colapsable. Sin esto, el chain-of-thought aparece expandido en cada mensaje.
- `3472f7438e` hace funcional el toggle `<leader>t` / `/thinking` (antes decorativo — keybind="none" + memo hardcodeado a `true`).
- `ef17facef9` corrige un falso positivo del reminder de plan-mode en sesiones largas (cambio mínimo, 2 líneas).

Mario decidió mantenerlo como fork interno (no se va a aceptar upstream). El objetivo de este doc es absorber cambios upstream con el menor ruido posible.

## Procedimiento de actualización (cuando `origin/dev` tenga cambios nuevos)

### Paso 1 — Fetch

```bash
cd "C:\Users\mario\Desktop\Automatizaciones\opencode-tmp"
git fetch origin dev
```

### Paso 2 — Ver cuántos commits faltan

```bash
git log --oneline HEAD..origin/dev
```

Si la lista es >10 commits, merece rebase manual. Si es ≤10, rebase lineal funciona limpio.

### Paso 3 — Rebase

```bash
git rebase origin/dev
```

**Conflictos probables** (por orden de probabilidad):

| Archivo | Por qué | Resolución típica |
|---|---|---|
| `packages/opencode/src/provider/transform.ts` | Ambos tocamos provider middleware (upstream puede cambiar formato de output) | Mantener `shouldParseThinkTags()` y aceptar upstream si cambia `LanguageModelV3Middleware` |
| `packages/opencode/src/session/llm.ts` | Wiring de middlewares | Manual, comparar contexto |
| `packages/opencode/src/session/llm/think-tag-middleware.ts` | Solo si upstream introduce su propia lógica de reasoning | Si upstream ya parsea think tags, **borrar el middleware local** y la entrada `shouldParseThinkTags` |
| `packages/tui/src/config/keybind.ts` | Bindings del TUI | Manual, mantener `<leader>t` |
| `packages/tui/src/routes/session/index.tsx` | Renderizado de mensajes | Manual, mantener `thinkingMode()` reactivo |
| `packages/opencode/src/session/reminders.ts` | Lógica de plan-mode | Manual, mantener `findLast()` |

### Paso 4 — Build

```bash
bun run --cwd packages/opencode build
```

Duración: **5-10 min** la primera vez (descarga deps + compila). Builds incrementales son ~1-2 min.

### Paso 5 — Verificar versión

```bash
& "C:\Users\mario\Desktop\Automatizaciones\opencode-tmp\packages\opencode\dist\opencode-windows-x64\bin\opencode.exe" --version
# Esperado: 0.0.0-fix-showthinking-thinking-<nuevo timestamp>
```

### Paso 6 — Commit del build artifact (opcional)

El binario en `dist/` **NO se commitea** (debe estar en `.gitignore`). Solo se commitea el código fuente. El wrapper `C:\Users\mario\.opencode\bin\opencode.cmd` ya apunta al path absoluto correcto.

### Paso 7 — Actualizar AGENTS.md §8

Tras cada rebase, los SHAs cambian. Actualizar `C:\Users\mario\Desktop\Automatizaciones\AGENTS.md` línea ~162:

```diff
-- **HEAD `ef17facef9`** (2026-08-14), 3 commits ahead de `origin/dev`:
+- **HEAD `<nuevo SHA>`** (fecha), N commits ahead de `origin/dev`:
-- `ef17facef9` fix(session): use findLast for plan-mode detection in reminders
+- `<nuevo SHA>` fix(session): ...
-- `2dba8f0fb5` feat(opencode): parse inline think tags as reasoning parts (MiniMax-M3)
+- ...
```

### Paso 8 — (Opcional) Push al fork remoto

```bash
git push fork fix-showthinking-thinking --force-with-lease
```

Solo si quieres tener backup en GitHub. **No obligatorio** — el repo local ya es la fuente de verdad.

## Chequeo rápido de salud

```bash
# Working tree limpio
git status --short

# 0 commits behind
git log --oneline HEAD..origin/dev | wc -l

# HEAD coincide con la rama en fork (si la subiste)
git rev-parse HEAD
git rev-parse fork/fix-showthinking-thinking

# Binario existe
Test-Path "C:\Users\mario\Desktop\Automatizaciones\opencode-tmp\packages\opencode\dist\opencode-windows-x64\bin\opencode.exe"
```

## Señales de que algo va mal

| Señal | Causa probable | Acción |
|---|---|---|
| `git status` muestra `M` o `??` | Working tree sucio | `git stash` o commitear antes de rebase |
| `git rebase` aborta con conflictos | Upstream tocó uno de los 6 archivos que modificamos | Resolver manualmente, `git rebase --continue` |
| `bun run --cwd packages/opencode build` falla con `cannot find module` | `bun.lock` stale o `node_modules` corrupto | `bun install --cwd opencode-tmp` y reintentar |
| Wrapper ejecuta versión vieja | Timestamp del binario no actualizado | `bun build` puede haber preservado cache; forzar rebuild borrando `dist/` antes |
| Bot Telegram se queja del binario | El bot usa `opencode.service` oficial, NO el fork local | No tocar — son cosas distintas |

## Política de commits en este fork

- Mensajes conventional commit: `type(scope): summary`. Tipos válidos: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`.
- Scope opcional (package o área): `session`, `tui`, `opencode`, `core`, `app`, `desktop`, `sdk`, `plugin`.
- **NO** branches con prefijo `feat/` o `fix/`. Solo nombres cortos separados por hyphens (max 3 palabras): `session-recovery`, `fix-scroll-state`.
- Default branch upstream es `dev` — siempre rebasear contra `dev`, nunca contra `main`.

## Backups

El `.git` de `opencode-tmp` es local (sin push al remoto). Si el disco muere, perdemos el fork. **Backup recomendado**: añadir `opencode-tmp` al backup de Hetzner Storage Box (ver `INFRA-NOTES.md § Backup policy`).
