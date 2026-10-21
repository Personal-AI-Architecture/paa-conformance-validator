# PAA Conformance Validator

Shared, language-neutral validator for the Personal AI Architecture contract
and template acceptance commands. It is intentionally dependency-free and
expects each implementation template to provide a `paa.target.json` manifest.

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

Its test suite covers missing locks, command execution and failure reporting,
malformed manifests, vendored hash/mirror drift, and mismatches against the
locked source commit. Run it with `npm test`.

To add another language template, provide the same manifest shape and map its
native typecheck, unit, integration, conformance, and acceptance commands in
the `commands` array. The validator does not assume a particular language or
build tool.
