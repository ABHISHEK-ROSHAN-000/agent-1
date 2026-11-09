import { dlopen, FFIType, ptr, toArrayBuffer } from "bun:ffi"

interface NativeDataBlob {
  readonly cbData: number
  readonly pbData: bigint | null
}

const CRYPTPROTECT_UI_FORBIDDEN = 0x1
const DATA_BLOB_SIZE = 16

if (process.platform !== "win32") {
  throw new Error("Windows DPAPI is only available on Windows")
}

const crypt32 = dlopen("crypt32.dll", {
  CryptProtectData: {
    args: [
      FFIType.ptr,
      FFIType.ptr,
      FFIType.ptr,
      FFIType.ptr,
      FFIType.ptr,
      FFIType.u32,
      FFIType.ptr,
    ],
    returns: FFIType.i32,
  },
  CryptUnprotectData: {
    args: [
      FFIType.ptr,
      FFIType.ptr,
      FFIType.ptr,
      FFIType.ptr,
      FFIType.ptr,
      FFIType.u32,
      FFIType.ptr,
    ],
    returns: FFIType.i32,
  },
})

const kernel32 = dlopen("kernel32.dll", {
  GetLastError: {
    args: [],
    returns: FFIType.u32,
  },
  LocalFree: {
    args: [FFIType.ptr],
    returns: FFIType.ptr,
  },
})

function writeBlob(view: DataView, data: Uint8Array): NativeDataBlob {
  if (data.byteLength > 0xffffffff) throw new Error("DPAPI input is too large")
  const dataPointer = data.byteLength === 0 ? null : ptr(data)
  view.setUint32(0, data.byteLength, true)
  view.setBigUint64(8, dataPointer === null ? 0n : BigInt(dataPointer), true)
  return {
    cbData: data.byteLength,
    pbData: dataPointer === null ? null : BigInt(dataPointer),
  }
}

function readBlob(view: DataView): NativeDataBlob {
  const cbData = view.getUint32(0, true)
  const rawPointer = view.getBigUint64(8, true)
  return {
    cbData,
    pbData: rawPointer === 0n ? null : rawPointer,
  }
}

function freeBlob(blob: NativeDataBlob): void {
  if (blob.pbData !== null) kernel32.symbols.LocalFree(blob.pbData)
}

function win32Error(operation: string): Error {
  const code = kernel32.symbols.GetLastError()
  return new Error(`${operation} failed with Windows error ${code}`)
}

export function dpapiProtect(secret: string): Uint8Array {
  const input = new TextEncoder().encode(secret)
  const inputBuffer = new Uint8Array(DATA_BLOB_SIZE)
  const inputView = new DataView(inputBuffer.buffer)
  const outputBuffer = new Uint8Array(DATA_BLOB_SIZE)
  const outputView = new DataView(outputBuffer.buffer)

  writeBlob(inputView, input)

  const ok = crypt32.symbols.CryptProtectData(
    ptr(inputBuffer),
    null,
    null,
    null,
    null,
    CRYPTPROTECT_UI_FORBIDDEN,
    ptr(outputBuffer),
  )
  if (ok === 0) throw win32Error("CryptProtectData")

  const output = readBlob(outputView)
  try {
    if (output.pbData === null || output.cbData === 0) {
      throw new Error("CryptProtectData returned an empty blob")
    }
    const bytes = new Uint8Array(toArrayBuffer(output.pbData, 0, output.cbData))
    return bytes.slice()
  } finally {
    freeBlob(output)
  }
}

export function dpapiUnprotect(blob: Uint8Array): string {
  if (blob.byteLength === 0) throw new Error("DPAPI blob is empty")
  const inputBuffer = new Uint8Array(DATA_BLOB_SIZE)
  const inputView = new DataView(inputBuffer.buffer)
  const outputBuffer = new Uint8Array(DATA_BLOB_SIZE)
  const outputView = new DataView(outputBuffer.buffer)
  writeBlob(inputView, blob)

  const ok = crypt32.symbols.CryptUnprotectData(
    ptr(inputBuffer),
    null,
    null,
    null,
    null,
    CRYPTPROTECT_UI_FORBIDDEN,
    ptr(outputBuffer),
  )
  if (ok === 0) throw win32Error("CryptUnprotectData")

  const output = readBlob(outputView)
  try {
    if (output.pbData === null || output.cbData === 0) {
      throw new Error("CryptUnprotectData returned an empty blob")
    }
    const bytes = new Uint8Array(toArrayBuffer(output.pbData, 0, output.cbData)).slice()
    return new TextDecoder().decode(bytes)
  } finally {
    freeBlob(output)
  }
}
