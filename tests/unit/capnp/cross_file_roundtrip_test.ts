// M1 codegen-qualification round trip: a host_control composite embedding
// common.capnp types, encoded and decoded through the PUBLISHED
// jsr:@nullstyle/capnp runtime codecs.
//
// capnpc-deno at the qualified toolchain commit cannot yet emit these
// descriptors itself: cross-file struct references are lowered to
// TYPE_ANY_POINTER and the referenced TypeScript names are left unimported
// (see compat/wire.json `codegen.blockers`). The descriptors below mirror,
// byte-for-byte in layout, what the emitter produces for common.capnp's own
// module plus what it SHOULD produce for host_control's `KillResults`
// wrapper (`kill @6 () -> (result :Common.EmptyResult)`), proving the
// published runtime handles the cross-file composite wire shape and that the
// remaining gap is confined to the code generator.
import { assertEquals } from "@std/assert";
import {
  decodeStructMessage,
  encodeStructMessage,
  TYPE_BOOL,
  TYPE_TEXT,
} from "@nullstyle/capnp/encoding";
import type {
  EnumTypeDescriptor,
  StructDescriptor,
} from "@nullstyle/capnp/encoding";

// --- common.capnp mirrors (identical to capnpc-deno output for common) ----

const ErrorCodeValues = [
  "unknown",
  "invalidArgument",
  "unauthenticated",
  "permissionDenied",
  "notFound",
  "alreadyExists",
  "failedPrecondition",
  "resourceExhausted",
  "aborted",
  "deadlineExceeded",
  "unavailable",
  "internal",
  "incompatibleProtocol",
  "incompatibleSchema",
  "incompatibleRuntime",
  "hostCapacity",
  "sandboxTerminated",
  "unsupportedFeature",
  "conflict",
  "cleanupIncomplete",
] as const;
type ErrorCode = typeof ErrorCodeValues[number];

const ErrorCodeType: EnumTypeDescriptor<ErrorCode> = {
  kind: "enum",
  byOrdinal: ErrorCodeValues,
  toOrdinal: Object.fromEntries(
    ErrorCodeValues.map((name, ordinal) => [name, ordinal]),
  ) as Record<ErrorCode, number>,
};

interface ErrorDetail {
  key: string;
  value: string;
}

const ErrorDetailStruct: StructDescriptor<ErrorDetail> = {
  kind: "struct",
  name: "ErrorDetail",
  dataWordCount: 0,
  pointerCount: 2,
  createDefault: () => ({ key: "", value: "" }),
  fields: [
    { kind: "slot", name: "key", offset: 0, type: TYPE_TEXT },
    { kind: "slot", name: "value", offset: 1, type: TYPE_TEXT },
  ],
};

interface SbxError {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  operationId: string;
  sandboxId: string;
  details: ErrorDetail[];
}

const SbxErrorStruct: StructDescriptor<SbxError> = {
  kind: "struct",
  name: "SbxError",
  dataWordCount: 1,
  pointerCount: 4,
  createDefault: () => ({
    code: ErrorCodeValues[0],
    message: "",
    retryable: false,
    operationId: "",
    sandboxId: "",
    details: [],
  }),
  fields: [
    { kind: "slot", name: "code", offset: 0, type: ErrorCodeType },
    { kind: "slot", name: "message", offset: 0, type: TYPE_TEXT },
    { kind: "slot", name: "retryable", offset: 16, type: TYPE_BOOL },
    { kind: "slot", name: "operationId", offset: 1, type: TYPE_TEXT },
    { kind: "slot", name: "sandboxId", offset: 2, type: TYPE_TEXT },
    {
      kind: "slot",
      name: "details",
      offset: 3,
      type: {
        kind: "list",
        element: { kind: "struct", get: () => ErrorDetailStruct },
      },
    },
  ],
};

interface Empty {
  _?: never;
}

const EmptyStruct: StructDescriptor<Empty> = {
  kind: "struct",
  name: "Empty",
  dataWordCount: 0,
  pointerCount: 0,
  createDefault: () => ({}),
  fields: [],
};

interface EmptyResult {
  which?: "ok" | "error";
  ok?: Empty;
  error?: SbxError;
}

const EmptyResultStruct: StructDescriptor<EmptyResult> = {
  kind: "struct",
  name: "EmptyResult",
  dataWordCount: 1,
  pointerCount: 1,
  createDefault: () => ({
    ok: EmptyStruct.createDefault(),
    error: SbxErrorStruct.createDefault(),
    which: "ok",
  }),
  union: {
    discriminantOffset: 0,
    defaultDiscriminant: 0,
    byName: { ok: 0, error: 1 },
    byDiscriminant: { 0: "ok", 1: "error" },
  },
  fields: [
    {
      kind: "slot",
      name: "ok",
      offset: 0,
      type: { kind: "struct", get: () => EmptyStruct },
      discriminantValue: 0,
    },
    {
      kind: "slot",
      name: "error",
      offset: 0,
      type: { kind: "struct", get: () => SbxErrorStruct },
      discriminantValue: 1,
    },
  ],
};

// --- host_control.capnp cross-file wrapper -------------------------------
// What capnpc-deno SHOULD emit for `KillResults { result :Common.EmptyResult }`.
// The actual generated descriptor lowers `result` to TYPE_ANY_POINTER.

interface KillResults {
  result: EmptyResult;
}

const KillResultsStruct: StructDescriptor<KillResults> = {
  kind: "struct",
  name: "KillResults",
  dataWordCount: 0,
  pointerCount: 1,
  createDefault: () => ({ result: EmptyResultStruct.createDefault() }),
  fields: [
    {
      kind: "slot",
      name: "result",
      offset: 0,
      type: { kind: "struct", get: () => EmptyResultStruct },
    },
  ],
};

Deno.test("published runtime round-trips a host_control composite embedding common types (error arm)", () => {
  const value: KillResults = {
    result: {
      which: "error",
      error: {
        code: "sandboxTerminated",
        message: "sandbox exited before kill completed",
        retryable: true,
        operationId: "op-42",
        sandboxId: "sbx-0001",
        details: [
          { key: "phase", value: "kill" },
          { key: "generation", value: "7" },
        ],
      },
    },
  };
  const encoded = encodeStructMessage(KillResultsStruct, value);
  const decoded = decodeStructMessage(KillResultsStruct, encoded);
  assertEquals(decoded.result.which, "error");
  const error = decoded.result.error;
  assertEquals(error?.code, "sandboxTerminated");
  assertEquals(error?.message, "sandbox exited before kill completed");
  assertEquals(error?.retryable, true);
  assertEquals(error?.operationId, "op-42");
  assertEquals(error?.sandboxId, "sbx-0001");
  assertEquals(error?.details, [
    { key: "phase", value: "kill" },
    { key: "generation", value: "7" },
  ]);
});

Deno.test("published runtime round-trips the same composite through the ok arm", () => {
  const encoded = encodeStructMessage(KillResultsStruct, {
    result: { which: "ok", ok: {} },
  });
  const decoded = decodeStructMessage(KillResultsStruct, encoded);
  assertEquals(decoded.result.which, "ok");
  assertEquals(decoded.result.ok, {});
  // Non-active union arms decode to their defaults, mirroring the generated
  // codec behavior for same-file unions.
  assertEquals(decoded.result.error?.code, "unknown");
});
