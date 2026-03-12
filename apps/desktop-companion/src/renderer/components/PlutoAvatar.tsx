import type { CSSProperties } from 'react';

export const plutoAudioState = {
    volume: 0,
    isSpeaking: false,
};

export function setPlutoSpeakingState(isSpeaking: boolean, volume?: number) {
    plutoAudioState.isSpeaking = isSpeaking;
    plutoAudioState.volume = isSpeaking ? Math.max(0, volume ?? 0.6) : 0;
}

export function resetPlutoSpeakingState() {
    plutoAudioState.isSpeaking = false;
    plutoAudioState.volume = 0;
}

interface CursorState {
    x: number;
    y: number;
    distance: number;
    near: boolean;
}

interface PlutoAvatarProps {
    avatarState: 'idle' | 'working' | 'alert' | 'offline';
    cursor: CursorState;
    isProcessing: boolean;
    isSpeaking: boolean;
    curious: boolean;
    phase: number;
    blink: number;
}

const ACTIVE_AVATAR_FPS = 20;
const IDLE_AVATAR_FPS = 6;

type PlutoAvatarViewModel = {
    isOffline: boolean;
    isAlert: boolean;
    speakingStrength: number;
    lookX: number;
    lookY: number;
    bobX: number;
    bobY: number;
    faceTilt: number;
    plutoColor: string;
    eyeScaleX: number;
    eyeScaleY: number;
    mouthScaleX: number;
    mouthScaleY: number;
    bitPulse: number;
};

export function PlutoAvatar(props: Readonly<PlutoAvatarProps>) {
    const model = buildAvatarViewModel(props);

    const shellStyle: CSSProperties = {
        width: 220,
        height: 220,
        margin: '0 auto',
        pointerEvents: 'none',
        position: 'relative',
        transform: `translate3d(${model.bobX.toFixed(2)}px, ${model.bobY.toFixed(2)}px, 0)`,
        transition: `transform ${Math.round(1000 / ACTIVE_AVATAR_FPS)}ms linear`,
        willChange: 'transform',
    };

    const faceStyle: CSSProperties = {
        position: 'absolute',
        inset: '16px',
        borderRadius: '999px',
        background: `radial-gradient(circle at 35% 30%, #e2bb9e 0%, ${model.plutoColor} 58%, #996f51 100%)`,
        boxShadow: model.isOffline
            ? 'inset -14px -20px 30px rgba(0, 0, 0, 0.18)'
            : 'inset -16px -22px 34px rgba(89, 53, 28, 0.22)',
        transform: `perspective(500px) rotateX(${(-model.lookY * 0.45).toFixed(2)}deg) rotateY(${(model.lookX * 0.55).toFixed(2)}deg) rotateZ(${model.faceTilt.toFixed(2)}deg)`,
        transition: 'transform 80ms linear',
        willChange: 'transform',
        overflow: 'hidden',
    };

    const eyeBaseStyle: CSSProperties = {
        position: 'absolute',
        top: '33%',
        width: 24,
        height: 24,
        borderRadius: '999px',
        background: '#FCF5F7',
        transform: `translate3d(${model.lookX.toFixed(2)}px, ${(model.lookY * 0.6).toFixed(2)}px, 0) scale(${model.eyeScaleX.toFixed(3)}, ${model.eyeScaleY.toFixed(3)})`,
        transition: 'transform 80ms linear',
        willChange: 'transform',
    };

    const mouthStyle: CSSProperties = {
        position: 'absolute',
        left: '50%',
        top: '61%',
        width: model.isOffline ? 42 : 28,
        height: model.isOffline ? 18 : 22,
        borderRadius: model.isOffline ? '0 0 999px 999px' : '999px',
        borderTop: model.isOffline ? '3px solid #EAEAEA' : undefined,
        background: model.isOffline ? 'transparent' : '#FCF5F7',
        transform: `translate3d(calc(-50% + ${model.lookX.toFixed(2)}px), ${(model.lookY * 0.4).toFixed(2)}px, 0) scale(${model.mouthScaleX.toFixed(3)}, ${model.mouthScaleY.toFixed(3)})`,
        transition: 'transform 80ms linear',
        willChange: 'transform',
    };

    return (
        <div style={shellStyle} className="pet-canvas" aria-hidden="true">
            {renderProcessingBits(props, model)}
            <div style={faceStyle}>
                {model.isOffline ? (
                    <>
                        <div
                            style={{
                                ...eyeBaseStyle,
                                left: '33%',
                                width: 26,
                                height: 4,
                                borderRadius: 999,
                                background: '#EAEAEA',
                                transform: `translate3d(${model.lookX.toFixed(2)}px, ${(model.lookY * 0.6).toFixed(2)}px, 0) rotate(18deg)`,
                            }}
                        />
                        <div
                            style={{
                                ...eyeBaseStyle,
                                right: '33%',
                                width: 26,
                                height: 4,
                                borderRadius: 999,
                                background: '#EAEAEA',
                                transform: `translate3d(${model.lookX.toFixed(2)}px, ${(model.lookY * 0.6).toFixed(2)}px, 0) rotate(-18deg)`,
                            }}
                        />
                    </>
                ) : (
                    <>
                        <div style={{ ...eyeBaseStyle, left: '31%' }} />
                        <div style={{ ...eyeBaseStyle, right: '31%' }} />
                    </>
                )}
                {model.isAlert && !model.isOffline ? (
                    <div
                        style={{
                            ...mouthStyle,
                            width: 24,
                            height: 24,
                            transform: `translate3d(calc(-50% + ${model.lookX.toFixed(2)}px), ${(model.lookY * 0.4).toFixed(2)}px, 0) scale(1, 1.18)`,
                        }}
                    />
                ) : (
                    <div style={mouthStyle} />
                )}
            </div>
        </div>
    );
}

function buildAvatarViewModel(props: Readonly<PlutoAvatarProps>) {
    const audioSpeaking = plutoAudioState.isSpeaking || props.isSpeaking;
    const isOffline = props.avatarState === 'offline';
    const isAlert = props.avatarState === 'alert';
    const speakingStrength = getSpeakingStrength(audioSpeaking);
    const lookX = clamp(props.cursor.x * 10, -10, 10);
    const lookY = clamp(props.cursor.y * 8, -8, 8);
    const bob = buildAvatarBob(props, audioSpeaking, speakingStrength);
    const eyeScaleYBase = props.curious
        ? 1.2
        : Math.max(0.1, 1 - props.blink * 0.9);
    const eyeScaleXBase = buildEyeScaleXBase(props);
    const eyeWiden =
        audioSpeaking && speakingStrength > 0.3
            ? 1 + (speakingStrength - 0.3) * 0.5
            : 1;

    return {
        isOffline,
        isAlert,
        speakingStrength,
        lookX,
        lookY,
        bobX: bob.x,
        bobY: bob.y,
        faceTilt: isOffline ? 0 : bob.x,
        plutoColor: isOffline ? '#848C98' : '#D1A384',
        eyeScaleX: eyeScaleXBase * eyeWiden,
        eyeScaleY: eyeScaleYBase * eyeWiden,
        mouthScaleX: isOffline ? 1 : 1 - Math.min(0.25, speakingStrength * 0.2),
        mouthScaleY: isOffline ? 1 : 0.35 + Math.min(1, speakingStrength * 1.5),
        bitPulse: props.isProcessing
            ? 0.62 + (Math.sin(props.phase * 8.5) + 1) * 0.19
            : 0,
    } satisfies PlutoAvatarViewModel;
}

function getSpeakingStrength(audioSpeaking: boolean) {
    if (!audioSpeaking) {
        return 0;
    }

    return Math.max(Math.min(1, Math.max(0, plutoAudioState.volume)), 0.55);
}

function buildAvatarBob(
    props: Readonly<PlutoAvatarProps>,
    audioSpeaking: boolean,
    speakingStrength: number,
) {
    if (audioSpeaking) {
        return {
            x:
                Math.cos(props.phase * ACTIVE_AVATAR_FPS * 0.3) *
                speakingStrength *
                3,
            y:
                Math.sin(props.phase * ACTIVE_AVATAR_FPS * 0.45) *
                speakingStrength *
                6,
        };
    }

    if (props.isProcessing) {
        return {
            x: Math.cos(props.phase * IDLE_AVATAR_FPS * 1.1) * 1.6,
            y: Math.sin(props.phase * IDLE_AVATAR_FPS * 1.4) * 2.4,
        };
    }

    return { x: 0, y: 0 };
}

function buildEyeScaleXBase(props: Readonly<PlutoAvatarProps>) {
    if (props.isProcessing) {
        return 1.08 + Math.sin(props.phase * 7.4) * 0.06;
    }

    if (props.curious) {
        return 1.2;
    }

    return 1;
}

function renderProcessingBits(
    props: Readonly<PlutoAvatarProps>,
    model: PlutoAvatarViewModel,
) {
    if (!props.isProcessing || model.isOffline) {
        return null;
    }

    const bits = [0, 1, 2].map((index) => {
        const orbitPhase = props.phase * 2.8 + index * 2.1;
        const orbitX = Math.cos(orbitPhase) * (44 + index * 8);
        const orbitY = Math.sin(orbitPhase) * (18 + index * 5);
        const size = 8 + (index % 2) * 2;

        const style: CSSProperties = {
            position: 'absolute',
            left: `calc(50% + ${orbitX.toFixed(2)}px)`,
            top: `calc(44% + ${orbitY.toFixed(2)}px)`,
            width: size,
            height: size,
            borderRadius: 999,
            background:
                index === 1
                    ? 'linear-gradient(135deg, rgba(123, 207, 255, 0.95), rgba(109, 140, 255, 0.72))'
                    : 'linear-gradient(135deg, rgba(112, 240, 175, 0.96), rgba(88, 199, 255, 0.7))',
            boxShadow:
                '0 0 18px rgba(112, 240, 175, 0.32), 0 0 10px rgba(124, 166, 255, 0.22)',
            opacity: clamp(model.bitPulse - index * 0.1, 0.28, 1),
            transform: `translate(-50%, -50%) scale(${(0.85 + model.bitPulse * 0.28 + index * 0.02).toFixed(3)})`,
            transition: 'transform 80ms linear, opacity 80ms linear',
            willChange: 'transform, opacity',
        };

        return <div key={`processing-bit-${index}`} style={style} />;
    });

    return <>{bits}</>;
}

function clamp(value: number, min: number, max: number) {
    return Math.max(min, Math.min(max, value));
}
