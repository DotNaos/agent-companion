declare abstract class AudioWorkletProcessor {
    readonly port: MessagePort;

    constructor(options?: AudioWorkletNodeOptions);

    abstract process(
        inputs: Float32Array[][],
        outputs: Float32Array[][],
        parameters: Record<string, Float32Array>,
    ): boolean;
}

declare function registerProcessor(
    name: string,
    processorCtor: new (options?: AudioWorkletNodeOptions) => AudioWorkletProcessor,
): void;

const DEFAULT_CHUNK_FRAMES = 2048;

class PlutoAudioCaptureProcessor extends AudioWorkletProcessor {
    private readonly chunkFrames: number;
    private readonly buffer: Float32Array;
    private writeOffset = 0;

    constructor(options?: AudioWorkletNodeOptions) {
        super();
        this.chunkFrames = Math.max(
            256,
            Number(options?.processorOptions?.chunkFrames) ||
                DEFAULT_CHUNK_FRAMES,
        );
        this.buffer = new Float32Array(this.chunkFrames);
        this.port.onmessage = (event: MessageEvent<{ type?: string }>) => {
            if (event.data?.type === 'flush') {
                this.flush();
                this.port.postMessage({ type: 'flush-complete' });
            }
        };
    }

    process(inputs: Float32Array[][], outputs: Float32Array[][]) {
        const input = inputs[0]?.[0];
        const outputChannels = outputs[0] ?? [];

        for (const channel of outputChannels) {
            channel.fill(0);
        }

        if (!input || input.length === 0) {
            return true;
        }

        let readOffset = 0;
        while (readOffset < input.length) {
            const remainingInput = input.length - readOffset;
            const remainingBuffer = this.chunkFrames - this.writeOffset;
            const framesToCopy = Math.min(remainingInput, remainingBuffer);

            this.buffer.set(
                input.subarray(readOffset, readOffset + framesToCopy),
                this.writeOffset,
            );
            this.writeOffset += framesToCopy;
            readOffset += framesToCopy;

            if (this.writeOffset === this.chunkFrames) {
                this.flush();
            }
        }

        return true;
    }

    private flush() {
        if (this.writeOffset === 0) {
            return;
        }

        const chunk = this.buffer.slice(0, this.writeOffset);
        this.writeOffset = 0;
        this.port.postMessage(chunk, [chunk.buffer]);
    }
}

registerProcessor('pluto-audio-capture', PlutoAudioCaptureProcessor);
