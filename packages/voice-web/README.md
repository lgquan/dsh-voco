# `@lgquan/dsh-voice-web`

English | [中文](README.zh.md)

Dedicated `/voice` WebSocket carrier. Binary client frames are 16 kHz PCM microphone chunks; binary server frames are 24 kHz PCM speech. JSON frames carry readiness, identified ASR and output text, task observations, speech lifecycle, audio commit, response-specific interruption, playback completion, and explicit `session.close`. An unexpected socket loss detaches the browser so reconnecting the same durable Voice Session within `reconnectGraceMs` reuses its exact provider conversation; explicit stop or a malformed or oversized frame final-closes it. Provider termination closes the browser transport instead of leaving the UI attached to a dead conversation. The route reuses the browser Host/Origin trust fence and does not share the ordinary RPC downlink.

## Model Experience

### Browser voice transport

#### What the model sees

The package contributes zero model-visible text; `/voice` transports audio and provider-independent lifecycle events only.

#### Token effect

Zero tokens are added directly.

#### KV Cache effect

WebSocket frames do not modify a model request or its reusable prefix.

## Known Limitations and Deferred Work

- Authentication remains the deployment's responsibility; `trustedHosts` is a DNS-rebinding and same-origin fence, not authentication.
