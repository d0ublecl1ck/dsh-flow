# dsh-flow

A DeepSeek Harness plugin bundle (client).

## Install into a profile

```sh
dsh plugin --profile <profile> add ./dsh-flow
dsh --profile <profile> --dump-config
```

The row id is flow; override its config from the profile
cordis.patch.yml by targeting that id (a patch replaces the whole config, so
restate every field you want to keep).

## Verify

Run the verification ladder so composition and real activation are both
checked before you trust the bundle you built.
