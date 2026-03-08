import type {
    VoiceConsoleInlineNotice,
    VoiceRoleStatus,
} from './PlutoVoiceSessionConsole.shared.js';

type AudioDeviceControlProps = Readonly<{
    isOverlay: boolean;
    availableInputs: MediaDeviceInfo[];
    availableOutputs: MediaDeviceInfo[];
    selectedInputId: string | null;
    selectedOutputId: string | null;
    canRouteOutputDevice: boolean;
    onSelectInput: (deviceId: string | null) => void;
    onSelectOutput: (deviceId: string | null) => void;
}>;

type VoiceConsoleSupportPanelProps = Readonly<{
    roleStatus: VoiceRoleStatus | null;
    activeStatusMessage: string | null;
    isRecording: boolean;
    liveMicFeedback: string;
    micLevel: number;
    inlineNotice: VoiceConsoleInlineNotice | null;
    canEnumerateDevices: boolean;
    isOverlay: boolean;
    availableInputs: MediaDeviceInfo[];
    availableOutputs: MediaDeviceInfo[];
    selectedInputId: string | null;
    selectedOutputId: string | null;
    canRouteOutputDevice: boolean;
    inputDeviceHint: string | null;
    onSelectInput: (deviceId: string | null) => void;
    onSelectOutput: (deviceId: string | null) => void;
}>;

export function VoiceConsoleSupportPanel({
    roleStatus,
    activeStatusMessage,
    isRecording,
    liveMicFeedback,
    micLevel,
    inlineNotice,
    canEnumerateDevices,
    isOverlay,
    availableInputs,
    availableOutputs,
    selectedInputId,
    selectedOutputId,
    canRouteOutputDevice,
    inputDeviceHint,
    onSelectInput,
    onSelectOutput,
}: VoiceConsoleSupportPanelProps) {
    return (
        <>
            {roleStatus ? (
                <div
                    className={
                        roleStatus.tone === 'accent'
                            ? 'mt-3 rounded-2xl border border-cyan-400/30 bg-cyan-500/10 p-3 text-xs text-cyan-100'
                            : 'mt-3 rounded-2xl border border-amber-400/30 bg-amber-500/10 p-3 text-xs text-amber-100'
                    }>
                    {roleStatus.message}
                </div>
            ) : null}

            {activeStatusMessage ? (
                <div className="mt-3 rounded-2xl border border-white/10 bg-white/5 p-3 text-xs text-slate-300">
                    {activeStatusMessage}
                </div>
            ) : null}

            {isRecording ? (
                <div className="mt-3 rounded-2xl border border-emerald-400/30 bg-emerald-500/10 p-3">
                    <div className="flex items-center justify-between gap-3">
                        <div>
                            <div className="text-sm font-semibold text-emerald-200">
                                Pluto is listening
                            </div>
                            <p className="mt-1 text-xs text-emerald-100/90">
                                {liveMicFeedback}
                            </p>
                        </div>
                        <MicLevelMeter level={micLevel} />
                    </div>
                </div>
            ) : null}

            {inlineNotice ? (
                <div
                    className={
                        inlineNotice.tone === 'error'
                            ? 'mt-3 rounded-2xl border border-red-400/30 bg-red-500/10 p-3 text-xs text-red-200'
                            : 'mt-3 rounded-2xl border border-cyan-400/30 bg-cyan-500/10 p-3 text-xs text-cyan-100'
                    }>
                    {inlineNotice.message}
                </div>
            ) : null}

            {canEnumerateDevices ? (
                <AudioDeviceControls
                    isOverlay={isOverlay}
                    availableInputs={availableInputs}
                    availableOutputs={availableOutputs}
                    selectedInputId={selectedInputId}
                    selectedOutputId={selectedOutputId}
                    canRouteOutputDevice={canRouteOutputDevice}
                    onSelectInput={onSelectInput}
                    onSelectOutput={onSelectOutput}
                />
            ) : null}

            {inputDeviceHint ? (
                <p className="text-xs text-slate-500">{inputDeviceHint}</p>
            ) : null}
        </>
    );
}

function AudioDeviceControls({
    isOverlay,
    availableInputs,
    availableOutputs,
    selectedInputId,
    selectedOutputId,
    canRouteOutputDevice,
    onSelectInput,
    onSelectOutput,
}: AudioDeviceControlProps) {
    const containerClassName = isOverlay
        ? 'grid gap-2 rounded-2xl border border-white/10 bg-black/20 p-3'
        : 'mt-4 grid gap-3 rounded-2xl border border-white/10 bg-black/20 p-3';
    const noteClassName = isOverlay
        ? 'text-[11px] text-amber-300/90'
        : 'text-xs text-amber-300/90';

    return (
        <div className={containerClassName}>
            <label className="grid gap-1.5 text-xs text-slate-400">
                <span className="font-medium text-slate-200">Microphone</span>
                <select
                    value={selectedInputId ?? 'default'}
                    onChange={(event) => {
                        const nextValue = event.target.value;
                        onSelectInput(
                            nextValue === 'default' ? null : nextValue,
                        );
                    }}
                    className="h-10 rounded-xl border border-white/10 bg-black/40 px-3 text-sm text-slate-100 outline-none transition focus:border-white/30">
                    <option value="default">System default</option>
                    {availableInputs.map((device, index) => (
                        <option key={device.deviceId} value={device.deviceId}>
                            {formatAudioDeviceLabel(
                                device,
                                index,
                                'Microphone',
                            )}
                        </option>
                    ))}
                </select>
            </label>

            <label className="grid gap-1.5 text-xs text-slate-400">
                <span className="font-medium text-slate-200">
                    Headphones / speakers
                </span>
                <select
                    value={selectedOutputId ?? 'default'}
                    onChange={(event) => {
                        const nextValue = event.target.value;
                        onSelectOutput(
                            nextValue === 'default' ? null : nextValue,
                        );
                    }}
                    disabled={!canRouteOutputDevice}
                    className="h-10 rounded-xl border border-white/10 bg-black/40 px-3 text-sm text-slate-100 outline-none transition focus:border-white/30 disabled:cursor-not-allowed disabled:opacity-60">
                    <option value="default">System default</option>
                    {availableOutputs.map((device, index) => (
                        <option key={device.deviceId} value={device.deviceId}>
                            {formatAudioDeviceLabel(device, index, 'Output')}
                        </option>
                    ))}
                </select>
            </label>

            {canRouteOutputDevice ? null : (
                <p className={noteClassName}>
                    This Electron runtime currently routes Pluto playback
                    through the system default output only.
                </p>
            )}
        </div>
    );
}

function MicLevelMeter({ level }: Readonly<{ level: number }>) {
    const bars = [0.18, 0.34, 0.5, 0.66, 0.82];

    return (
        <div className="flex min-w-18 items-end gap-1 rounded-full border border-emerald-300/20 bg-black/20 px-3 py-2">
            {bars.map((threshold, index) => {
                const active = level >= threshold;
                return (
                    <span
                        key={threshold}
                        className={
                            active ? 'bg-emerald-300' : 'bg-emerald-900/60'
                        }
                        style={{
                            width: '0.35rem',
                            height: `${0.55 + index * 0.3}rem`,
                            borderRadius: '999px',
                            transition: 'background-color 120ms ease',
                        }}
                    />
                );
            })}
        </div>
    );
}

function formatAudioDeviceLabel(
    device: MediaDeviceInfo,
    index: number,
    fallbackPrefix: string,
) {
    const label = device.label.trim();
    if (label) {
        return label;
    }
    return `${fallbackPrefix} ${index + 1}`;
}
