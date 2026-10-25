# PAA Conformance Validator

Shared, language-neutral validator for the Personal AI Architecture contract
and template acceptance commands. It is intentionally dependency-free and
expects each implementation template to provide a `paa.target.json` manifest.

## Live Gateway check

`paa-live-target` starts the target's `live.start` command with a temporary owner
token and memory root. It checks unauthenticated and spoofed requests, both PAA
credential headers, the request size limit, streamed event discriminators,
conversation persistence, list filters and pagination, then restarts the server
and reads the saved conversation again. A failure exits nonzero.

```bash
node bin/paa-live-target.js --target ../python-architecture-template/paa.target.json
node bin/paa-live-target.js --target ../go-architecture-template/paa.target.json --docker-image golang:1.22-alpine
node bin/paa-live-target.js --target ../java-architecture-template/paa.target.json --docker-image maven:3.9-eclipse-temurin-17-alpine
```

Use `node bin/paa-live.js --url http://127.0.0.1:8000 --api-key <test-token>`
to check a service already running. The runner exercises a bounded text journey;
it is not a full PAA conformance verdict. Contract pin checks and each target's
native suites remain separate required gates.

`paa-provider-target` repeats the live journey with an OpenAI-compatible
fixture server. For targets declaring `live.preference_path`, it updates owner
preferences on the running server and checks two models and two provider
profiles without restart, saved reply provenance, rejection of an unknown
model without fallback, and preference persistence after restart. Older
targets without that manifest field retain the startup selection check:

```bash
node bin/paa-provider-target.js --target ../python-architecture-template/paa.target.json
```

From this workspace, validate any template against its pinned local PAA source
checkout with:

```bash
node bin/paa-validate.js \
  --target ../../ts-architecture-template/paa.target.json \
  --source-checkout ../../personal-ai-architecture
```

For the language templates staged in this workspace:

```bash
node bin/paa-validate.js \
  --target ../python-architecture-template/paa.target.json \
  --source-checkout ../../personal-ai-architecture

node bin/paa-validate.js \
  --target ../go-architecture-template/paa.target.json \
  --source-checkout ../../personal-ai-architecture

node bin/paa-validate.js \
  --target ../rust-architecture-template/paa.target.json \
  --source-checkout ../../personal-ai-architecture

node bin/paa-validate.js \
  --target ../java-architecture-template/paa.target.json \
  --source-checkout ../../personal-ai-architecture
```

The validator checks the target manifest, pinned contract files, vendored and
mirrored contract bytes, the local PAA source at the locked commit, and every
command declared by the target. Use `--contracts-only` or `--commands-only`
when isolating one side of the validation.

To require alignment with an accepted PAA ref as well as the historical pin,
add `--source-ref origin/main` and fetch that ref in the source checkout first.
This compares the complete locked OpenAPI/schema file set and bytes with the
selected ref. It reports an old `specs/` pin as stale when accepted PAA uses
`contracts/`. The validator supports both layouts during migration.

If a target's language toolchain is unavailable on the host, use
`--docker-image <image>` to run its declared commands in a container while
checking contracts on the host. The target directory is mounted at `/work`;
the command image must provide `sh` and the target toolchain. For example,
Go can use `golang:1.22-alpine`, and Java can use
`maven:3.9-eclipse-temurin-17-alpine`. The validator uses the current user ID
so generated files remain owned by the operator. Docker images should be
pulled or pinned by the operator before use.

For a full workspace check, run the shared validator for each target above
without `--contracts-only`, then run each template's native aggregate command:

| Template | Native aggregate command (from template root) |
|---|---|
| TypeScript | `npm run check:conformance && npm test && npm run acceptance:check` |
| Python | `python scripts/validate.py --source-checkout <PAA checkout>` |
| Go | `go run ./cmd/validate` |
| Rust | `cargo run --bin paa-validate -- --source-checkout <PAA checkout>` |
| Java | `sh scripts/validate.sh && mvn -q test` |

For Go and Java, run the shared validator with their Docker images when the
host has no toolchain. Their native commands can run in the same images with
the template mounted at `/work`; use `sh -c`, not a login shell, so the image's
toolchain stays on `PATH`. A current-architecture result also requires
`--source-ref origin/main` after fetching the PAA source checkout. A pass
without that flag proves the pinned baseline only.

Its test suite covers missing locks, command execution and failure reporting,
malformed manifests, vendored hash/mirror drift, and mismatches against the
locked source commit. Run it with `npm test`.

To add another language template, provide the same manifest shape and map its
native typecheck, unit, integration, conformance, and acceptance commands in
the `commands` array. The validator does not assume a particular language or
build tool.
