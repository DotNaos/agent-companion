export async function parseJsonWebSocketData<T>(
    data: Blob | ArrayBuffer | ArrayBufferView | string,
) {
    const text = await readWebSocketDataAsText(data);
    return JSON.parse(text) as T;
}

async function readWebSocketDataAsText(
    data: Blob | ArrayBuffer | ArrayBufferView | string,
) {
    if (typeof data === 'string') {
        return data;
    }

    if (data instanceof Blob) {
        return data.text();
    }

    if (data instanceof ArrayBuffer) {
        return new TextDecoder().decode(data);
    }

    if (ArrayBuffer.isView(data)) {
        return new TextDecoder().decode(
            data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
        );
    }

    throw new TypeError('Unsupported WebSocket message payload type.');
}
