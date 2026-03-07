import {
    notifyPlutoInputSchema,
    plutoCommentaryInputSchema,
	plutoVoiceSessionAudioChunkSchema,
	plutoVoiceSessionStreamEventSchema,
    plutoMessageSchema,
    type NotifyPlutoInput,
    type PlutoCommentaryInput,
    type PlutoDelivery,
    type PlutoMessage,
    type PlutoTone,
	type PlutoVoiceSessionAudioChunk,
	type PlutoVoiceSessionStreamEvent,
} from "@agent-companion/shared";
import {
    GoogleGenAI,
    MediaResolution,
    Modality,
    type GenerateContentResponse,
    type LiveServerMessage,
    type PartUnion,
} from "@google/genai";
import fs from "node:fs";
import path from "node:path";
import type { RunnerEnv } from "./env.js";

interface InlineImageInput {
	data: string;
	mimeType: string;
}

interface GeneratePlutoMessageOptions {
	source: PlutoMessage["source"];
	title?: string;
	delivery: PlutoDelivery;
	tone: PlutoTone;
	message: string;
	context?: string;
	screenshotBase64?: string;
	screenshotMimeType?: string;
	muted: boolean;
	actorEmail?: string;
}

interface GeneratedPayload {
	message: PlutoMessage;
	usedFallback: boolean;
}

type LiveSessionConnection = Awaited<ReturnType<GoogleGenAI["live"]["connect"]>>;

interface PlutoVoiceSessionRegistration {
	emit: (event: PlutoVoiceSessionStreamEvent) => void;
}

class PlutoVoiceSessionRuntime {
	private session: LiveSessionConnection | null = null;
	private connecting: Promise<LiveSessionConnection> | null = null;
	private closing = false;

	constructor(
		private readonly ai: GoogleGenAI,
		private readonly env: RunnerEnv,
		private readonly sessionId: string,
		private readonly emit: (event: PlutoVoiceSessionStreamEvent) => void,
	) {}

	async sendAudioChunk(chunk: PlutoVoiceSessionAudioChunk) {
		const parsed = plutoVoiceSessionAudioChunkSchema.parse(chunk);
		const session = await this.ensureSession();
		this.emitEvent({
			type: "status",
			status: "listening",
		});
		session.sendRealtimeInput({
			audio: {
				data: parsed.audioBase64,
				mimeType: parsed.mimeType,
			},
		});
	}

	async endAudioStream() {
		const session = await this.ensureSession();
		session.sendRealtimeInput({
			audioStreamEnd: true,
		});
	}

	close(reason: string | null = "session_closed") {
		this.closing = true;
		this.session?.close();
		this.session = null;
		this.connecting = null;
		this.emitEvent({
			type: "closed",
			reason,
		});
	}

	private async ensureSession() {
		if (this.session) {
			return this.session;
		}
		if (this.connecting) {
			return this.connecting;
		}

		this.connecting = this.ai.live.connect({
			model: this.env.PLUTO_MODEL,
			callbacks: {
				onmessage: (message: LiveServerMessage) => {
					this.handleMessage(message);
				},
				onerror: (event: ErrorEvent) => {
					this.session = null;
					this.connecting = null;
					this.emitEvent({
						type: "error",
						code: "PLUTO_LIVE_ERROR",
						message: event.message,
					});
				},
				onclose: (event: CloseEvent) => {
					this.session = null;
					this.connecting = null;
					if (!this.closing) {
						this.emitEvent({
							type: "closed",
							reason: event.reason || null,
						});
					}
					this.closing = false;
				},
			},
			config: {
				responseModalities: [Modality.AUDIO],
				inputAudioTranscription: {},
				outputAudioTranscription: {},
				speechConfig: {
					voiceConfig: {
						prebuiltVoiceConfig: {
							voiceName: this.env.PLUTO_VOICE_NAME || "Achird",
						},
					},
				},
			},
		})
			.then((session) => {
				this.session = session;
				this.connecting = null;
				this.closing = false;
				return session;
			})
			.catch((error) => {
				this.connecting = null;
				throw error;
			});

		return this.connecting;
	}

	private handleMessage(message: LiveServerMessage) {
		const content = message.serverContent;
		const inputTranscription = content?.inputTranscription?.text?.trim();
		if (inputTranscription) {
			this.emitEvent({
				type: "input_transcription",
				text: inputTranscription,
			});
		}

		const outputTranscription = content?.outputTranscription?.text?.trim();
		if (outputTranscription) {
			this.emitEvent({
				type: "output_transcription",
				text: outputTranscription,
			});
		}

		for (const part of content?.modelTurn?.parts ?? []) {
			if (part.inlineData?.data) {
				this.emitEvent({
					type: "audio_chunk",
					audioBase64: part.inlineData.data,
					mimeType: part.inlineData.mimeType ?? "audio/pcm;rate=24000",
				});
			}
		}

		if (content?.interrupted) {
			this.emitEvent({
				type: "status",
				status: "idle",
				interrupted: true,
			});
		}

		if (content?.waitingForInput) {
			this.emitEvent({
				type: "status",
				status: "idle",
				waitingForInput: true,
			});
		}

		if (content?.generationComplete) {
			this.emitEvent({
				type: "status",
				status: "responding",
			});
		}

		if (content?.turnComplete) {
			this.emitEvent({
				type: "status",
				status: "idle",
			});
		}
	}

	private emitEvent(event: PlutoVoiceSessionStreamEvent) {
		this.emit(plutoVoiceSessionStreamEventSchema.parse(event));
	}
}

export class PlutoService {
	private readonly ai: GoogleGenAI | null;
	private readonly recentMessages: string[] = [];
	private readonly voiceSessionRegistrations = new Map<string, PlutoVoiceSessionRegistration>();
	private readonly voiceSessionRuntimes = new Map<string, PlutoVoiceSessionRuntime>();

	constructor(private readonly env: RunnerEnv) {
		this.ai = env.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: env.GEMINI_API_KEY }) : null;
		fs.mkdirSync(env.PLUTO_AUDIO_DIR, { recursive: true });
	}

	isAvailable() {
		return this.ai !== null;
	}

	getModel() {
		return this.env.PLUTO_MODEL;
	}

	registerVoiceSession(sessionId: string, registration: PlutoVoiceSessionRegistration) {
		this.voiceSessionRegistrations.set(sessionId, registration);
	}

	unregisterVoiceSession(sessionId: string) {
		this.voiceSessionRegistrations.delete(sessionId);
		const runtime = this.voiceSessionRuntimes.get(sessionId);
		if (runtime) {
			runtime.close();
			this.voiceSessionRuntimes.delete(sessionId);
		}
	}

	async sendVoiceSessionAudioChunk(sessionId: string, chunk: PlutoVoiceSessionAudioChunk) {
		if (!this.ai) {
			throw new Error("Gemini is not configured for Pluto live voice sessions");
		}
		const runtime = this.getOrCreateVoiceSessionRuntime(sessionId);
		await runtime.sendAudioChunk(chunk);
	}

	async endVoiceSessionAudio(sessionId: string) {
		if (!this.ai) {
			throw new Error("Gemini is not configured for Pluto live voice sessions");
		}
		const runtime = this.getOrCreateVoiceSessionRuntime(sessionId);
		await runtime.endAudioStream();
	}

	async notify(input: NotifyPlutoInput, options: { muted: boolean; actorEmail: string }): Promise<GeneratedPayload> {
		const parsed = notifyPlutoInputSchema.parse(input);
		const shouldUseGemini = parsed.delivery === "summarize" || parsed.delivery === "speak";
		if (!shouldUseGemini || !this.ai) {
			return {
				message: this.buildFallbackMessage({
					source: "remote-agent",
					title: parsed.title,
					delivery: parsed.delivery,
					tone: parsed.tone,
					message: parsed.message,
					context: parsed.context,
					muted: options.muted,
					actorEmail: options.actorEmail,
				}),
				usedFallback: shouldUseGemini,
			};
		}

		return {
			message: await this.generateMessage({
				source: "remote-agent",
				title: parsed.title,
				delivery: parsed.delivery,
				tone: parsed.tone,
				message: parsed.message,
				context: parsed.context,
				muted: options.muted,
				actorEmail: options.actorEmail,
			}),
			usedFallback: false,
		};
	}

	async createAutonomousCommentary(
		input: PlutoCommentaryInput,
		options: { muted: boolean },
	): Promise<GeneratedPayload> {
		const parsed = plutoCommentaryInputSchema.parse(input);
		if (!this.ai) {
			return {
				message: this.buildFallbackMessage({
					source: "autonomous",
					title: "Pluto",
					delivery: options.muted ? "bubble" : "speak",
					tone: "humorous",
					message:
						"Ich wäre bereit für einen klugen Kommentar, sobald du mir einen Gemini-Schlüssel gönnst. Bis dahin halte ich immerhin professionell Wache.",
					context: parsed.contextHint,
					muted: options.muted,
				}),
				usedFallback: true,
			};
		}

		return {
			message: await this.generateMessage({
				source: "autonomous",
				title: "Pluto",
				delivery: options.muted ? "bubble" : "speak",
				tone: "humorous",
				message: parsed.contextHint ?? "Comment on what the user appears to be doing right now.",
				screenshotBase64: parsed.screenshotBase64,
				screenshotMimeType: parsed.mimeType,
				muted: options.muted,
			}),
			usedFallback: false,
		};
	}

	readAudio(messageId: string) {
		const filePath = path.join(this.env.PLUTO_AUDIO_DIR, `${messageId}.wav`);
		if (!fs.existsSync(filePath)) {
			return null;
		}
		return {
			contentType: "audio/wav",
			buffer: fs.readFileSync(filePath),
		};
	}

	private async generateMessage(options: GeneratePlutoMessageOptions): Promise<PlutoMessage> {
		const messageId = crypto.randomUUID();
		const prompt = this.buildPrompt(options);
		const inlineImage = options.screenshotBase64
			? {
					data: options.screenshotBase64,
					mimeType: options.screenshotMimeType ?? "image/png",
				}
			: undefined;

		let text = "";
		let audioAvailable = false;

		const useAudio = options.delivery !== "bubble" && !options.muted;
		const isLiveModel = this.env.PLUTO_MODEL.includes("audio") || this.env.PLUTO_MODEL.includes("live");
		const persistAudio = (audioParts: string[], audioMimeType: string) => {
			if (audioParts.length === 0 || !audioMimeType) {
				return false;
			}
			const filePath = path.join(this.env.PLUTO_AUDIO_DIR, `${messageId}.wav`);
			fs.writeFileSync(filePath, convertToWav(audioParts, audioMimeType));
			return true;
		};

		if (isLiveModel && useAudio) {
			const turn = buildLiveTurn(prompt, inlineImage);
			const response = await this.runLiveTurn(turn, [Modality.AUDIO], useAudio).catch((e) => {
				console.error("Pluto Live turn failed:", e);
				return null;
			});

			if (response) {
				text = response.text.trim();
				audioAvailable = persistAudio(response.audioParts, response.audioMimeType);
			}
		} else {
			const textResponse = await this.runTextTurn(prompt, inlineImage);
			text = textResponse.trim();

			if (text && useAudio) {
				const audioResponse = await this.runAudioTurn(text).catch(() => null);
				if (audioResponse) {
					audioAvailable = persistAudio(audioResponse.audioParts, audioResponse.audioMimeType);
				}
			}
		}

		text = text || this.buildFallbackText(options.message, options.context, options.delivery, options.tone);
		this.updateMemory(text);

		return plutoMessageSchema.parse({
			id: messageId,
			source: options.source,
			delivery: options.delivery,
			tone: options.tone,
			title: options.title ?? null,
			text,
			createdAt: new Date().toISOString(),
			expiresAt: new Date(Date.now() + 45_000).toISOString(),
			audioAvailable,
		});
	}

	private buildFallbackMessage(options: GeneratePlutoMessageOptions): PlutoMessage {
		const text = this.buildFallbackText(options.message, options.context, options.delivery, options.tone);
		this.updateMemory(text);

		return plutoMessageSchema.parse({
			id: crypto.randomUUID(),
			source: options.source,
			delivery: options.delivery,
			tone: options.tone,
			title: options.title ?? null,
			text,
			createdAt: new Date().toISOString(),
			expiresAt: new Date(Date.now() + 45_000).toISOString(),
			audioAvailable: false,
		});
	}

	private buildFallbackText(
		message: string,
		context: string | undefined,
		delivery: PlutoDelivery,
		tone: PlutoTone,
	) {
		const rawMessage = [message, context]
			.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
			.join(" ");
		const normalized = rawMessage.replaceAll(/\s+/g, " ").trim();
		let clipped = normalized;
		if (normalized.length > 280) {
			clipped = `${normalized.slice(0, 277)}…`;
		}
		let prefix = "Kleiner Aufmunterungsbericht:";
		if (tone === "urgent") {
			prefix = "Kurzer Zwischenruf:";
		} else if (tone === "humorous") {
			prefix = "Pluto meldet charmant:";
		} else if (tone === "neutral") {
			prefix = "Kurzinfo:";
		}

		if (delivery === "summarize") {
			return `${prefix} ${clipped}`;
		}

		return clipped || "Ich habe gerade nichts Gescheites zu sagen, aber ich sehe geschniegelt und gebügelt aus.";
	}

	private updateMemory(text: string) {
		if (!text) return;
		this.recentMessages.push(text);
		if (this.recentMessages.length > 5) {
			this.recentMessages.shift();
		}
	}

	private buildPrompt(options: GeneratePlutoMessageOptions) {
		const voiceInstruction = "Return text only.";
		const memoryInstruction = this.recentMessages.length > 0
			? `You recently said:
${this.recentMessages.slice(-3).map(m => `- "${m}"`).join('\n')}
Do not repeat these phrases or sentiments. Keep your commentary fresh and diverse.`
			: "";
		const identityInstruction = "Your name is Pluto. You are an autonomous, friendly desktop sidekick and secretary companion residing on the user's screen in a small widget. You act as an intermediary for remote AI coding agents, but you also have your own personality (witty, lightly humorous, very encouraging, briefly professional).";

		if (options.source === "autonomous") {
			return [
				identityInstruction,
				"Look at the user's current screenshot and make one short, context-sensitive comment in German.",
				"Be encouraging, a little witty, and observant. Max 2 short sentences.",
				"Do not mention passwords, secrets, personal data, or anything you are unsure about. If uncertain, say so playfully.",
				"No markdown, no bullet points, no stage directions.",
				memoryInstruction,
				voiceInstruction,
				options.message ? `Extra hint: ${options.message}` : "",
			]
				.filter(Boolean)
				.join("\n\n");
		}

		let summarizeInstruction = "";
		if (options.delivery === "summarize") {
			summarizeInstruction = "Summarize the remote agent's update for the user in 1 to 3 short German sentences, like a witty but competent secretary. Mention any action the user should care about.";
		} else {
			summarizeInstruction = "Rephrase the remote agent's request into a short German message you (Pluto) can tell the user naturally.";
		}

		return [
			identityInstruction,
			"Speak directly to the user in natural German. Sound human, concise, and lightly playful.",
			summarizeInstruction,
			`Tone: ${options.tone}.`,
			"Do not use markdown, bullets, or long preambles.",
			memoryInstruction,
			voiceInstruction,
			options.title ? `Title: ${options.title}` : "",
			`Primary message: ${options.message}`,
			options.context ? `Additional context from the remote agent:\n${options.context}` : "",
			options.actorEmail ? `Remote agent actor: ${options.actorEmail}` : "",
		]
			.filter(Boolean)
			.join("\n\n");
	}

	private buildSpeechPrompt(text: string) {
		return [
			"Speak the following German text naturally and warmly.",
			"Do not add, remove, summarize, translate, or paraphrase anything.",
			"Return audio only.",
			`Text: ${text}`,
		].join("\n\n");
	}

	private async runTextTurn(prompt: string, inlineImage?: InlineImageInput) {
		if (!this.ai) {
			return "";
		}

		try {
			const response = await this.ai.models.generateContent({
				model: resolvePlutoTextModel(this.env.PLUTO_MODEL),
				contents: buildGenerateContentParts(prompt, inlineImage),
				config: {
					mediaResolution: MediaResolution.MEDIA_RESOLUTION_MEDIUM,
				},
			});

			return extractResponseText(response);
		} catch (error) {
			console.error("Pluto API generation failed:", error instanceof Error ? error.message : error);
			return "";
		}
	}

	private async runAudioTurn(text: string) {
		return this.runLiveTurn(
			buildLiveTurn(this.buildSpeechPrompt(text)),
			[Modality.AUDIO],
			true,
		);
	}

	private async runLiveTurn(
		turns: Array<{
			role: "user";
			parts: Array<
				| { text: string }
				| { inlineData: InlineImageInput }
			>;
		}>,
		responseModalities: Modality[],
		includeAudio: boolean,
	) {
		if (!this.ai) {
			return {
				text: "",
				audioParts: [] as string[],
				audioMimeType: "",
			};
		}

		const textParts: string[] = [];
		const transcriptParts: string[] = [];
		const audioParts: string[] = [];
		let audioMimeType = "";
		let resolveTurn: (() => void) | null = null;
		let rejectTurn: ((error: Error) => void) | null = null;

		const completed = new Promise<void>((resolve, reject) => {
			resolveTurn = resolve;
			rejectTurn = reject;
		});

		const session = await this.ai.live.connect({
			model: this.env.PLUTO_MODEL,
			callbacks: {
				onmessage: (message: LiveServerMessage) => {
					const transcription = message.serverContent?.outputTranscription?.text?.trim();
					if (transcription) {
						transcriptParts.push(transcription);
					}
					for (const part of message.serverContent?.modelTurn?.parts ?? []) {
						if (part.text && !("thought" in part && part.thought)) {
							textParts.push(part.text);
						}
						if (part.inlineData?.data) {
							audioParts.push(part.inlineData.data);
							audioMimeType = part.inlineData.mimeType ?? audioMimeType;
						}
					}
					if (message.serverContent?.turnComplete) {
						resolveTurn?.();
					}
				},
				onerror: (event: ErrorEvent) => {
					rejectTurn?.(new Error(event.message));
				},
				onclose: (event: CloseEvent) => {
					if (!textParts.length && !audioParts.length && event.reason) {
						rejectTurn?.(new Error(event.reason));
					}
				},
			},
			config: {
				responseModalities,
				outputAudioTranscription: includeAudio ? {} : undefined,
				speechConfig: includeAudio
					? {
							voiceConfig: {
								prebuiltVoiceConfig: {
									voiceName: this.env.PLUTO_VOICE_NAME || "Achird",
								},
							},
						}
					: undefined,
			},
		});

		try {
			session.sendClientContent({
				turns,
				turnComplete: true,
			});

			await Promise.race([
				completed,
				new Promise<void>((_, reject) => {
					setTimeout(() => reject(new Error("Pluto generation timed out")), 45_000);
				}),
			]);
		} finally {
			session.close();
		}

		return {
			text: transcriptParts.join(" ").trim() || textParts.join("\n").trim(),
			audioParts,
			audioMimeType,
		};
	}

	private getOrCreateVoiceSessionRuntime(sessionId: string) {
		const existing = this.voiceSessionRuntimes.get(sessionId);
		if (existing) {
			return existing;
		}

		if (!this.ai) {
			throw new Error("Gemini is not configured for Pluto live voice sessions");
		}

		const registration = this.voiceSessionRegistrations.get(sessionId);
		if (!registration) {
			throw new Error(`Pluto voice session ${sessionId} is not registered`);
		}

		const runtime = new PlutoVoiceSessionRuntime(this.ai, this.env, sessionId, registration.emit);
		this.voiceSessionRuntimes.set(sessionId, runtime);
		return runtime;
	}
}

export function resolvePlutoTextModel(audioModel: string) {
	const normalized = audioModel.replace(/^models\//, "");
	if (normalized.includes("native-audio") || normalized.includes("live")) {
		return "gemini-2.5-flash";
	}
	return normalized;
}

export function buildGenerateContentParts(
	prompt: string,
	inlineImage?: InlineImageInput,
): PartUnion[] {
	return [
		...(inlineImage ? [{ inlineData: inlineImage }] : []),
		prompt,
	];
}

function extractResponseText(response: GenerateContentResponse) {
	if (typeof response.text === 'string' && response.text.trim().length > 0) {
		return response.text.trim();
	}

	for (const candidate of response.candidates ?? []) {
		for (const part of candidate.content?.parts ?? []) {
			if (part.text?.trim()) {
				return part.text.trim();
			}
		}
	}

	return '';
}

interface WavConversionOptions {
	numChannels: number;
	sampleRate: number;
	bitsPerSample: number;
}

function convertToWav(rawData: string[], mimeType: string) {
	const options = parseMimeType(mimeType);
	const buffer = Buffer.concat(rawData.map((data) => Buffer.from(data, "base64")));
	const wavHeader = createWavHeader(buffer.byteLength, options);
	return Buffer.concat([wavHeader, buffer]);
}

export function buildLiveTurn(prompt: string, inlineImage?: InlineImageInput) {
	return [
		{
			role: "user" as const,
			parts: [
				{ text: prompt },
				...(inlineImage ? [{ inlineData: inlineImage }] : []),
			],
		},
	];
}

function parseMimeType(mimeType: string) {
	const [fileType, ...params] = mimeType.split(";").map((entry) => entry.trim());
	const format = fileType.split("/")[1];

	const options: Partial<WavConversionOptions> = {
		numChannels: 1,
		bitsPerSample: 16,
		sampleRate: 24_000,
	};

	if (format?.startsWith("L")) {
		const bits = Number.parseInt(format.slice(1), 10);
		if (!Number.isNaN(bits)) {
			options.bitsPerSample = bits;
		}
	}

	for (const param of params) {
		const [key, value] = param.split("=").map((entry) => entry.trim());
		if (key === "rate") {
			const rate = Number.parseInt(value ?? "", 10);
			if (!Number.isNaN(rate)) {
				options.sampleRate = rate;
			}
		}
	}

	return options as WavConversionOptions;
}

function createWavHeader(dataLength: number, options: WavConversionOptions) {
	const { numChannels, sampleRate, bitsPerSample } = options;
	const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
	const blockAlign = (numChannels * bitsPerSample) / 8;
	const buffer = Buffer.alloc(44);

	buffer.write("RIFF", 0);
	buffer.writeUInt32LE(36 + dataLength, 4);
	buffer.write("WAVE", 8);
	buffer.write("fmt ", 12);
	buffer.writeUInt32LE(16, 16);
	buffer.writeUInt16LE(1, 20);
	buffer.writeUInt16LE(numChannels, 22);
	buffer.writeUInt32LE(sampleRate, 24);
	buffer.writeUInt32LE(byteRate, 28);
	buffer.writeUInt16LE(blockAlign, 32);
	buffer.writeUInt16LE(bitsPerSample, 34);
	buffer.write("data", 36);
	buffer.writeUInt32LE(dataLength, 40);

	return buffer;
}
