import { RoundedBox, Sphere } from '@react-three/drei';
import { Canvas, useFrame } from '@react-three/fiber';
import { useRef } from 'react';
import * as THREE from 'three';

export const plutoAudioState = {
    volume: 0,
    isSpeaking: false,
};

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

function PlutoScene({
    avatarState,
    cursor,
    isProcessing,
    curious,
    blink,
}: PlutoAvatarProps) {
    const groupRef = useRef<THREE.Group>(null);
    const animatedMouthRef = useRef<THREE.Mesh>(null);
    const animatedLeftEyeRef = useRef<THREE.Mesh>(null);
    const animatedRightEyeRef = useRef<THREE.Mesh>(null);

    const targetLook = useRef(new THREE.Vector2());
    const randomnessRef = useRef({ x: 0, y: 0, until: 0 });
    const springX = useRef({ v: 0, val: 0 });
    const springY = useRef({ v: 0, val: 0 });

    const isOffline = avatarState === 'offline';
    const isAlert = avatarState === 'alert';
    const plutoColor = isOffline ? '#848C98' : '#D1A384';

    let eyeScaleY = 1;
    let eyeScaleX = 1;
    if (curious) {
        eyeScaleY = 1.2;
        eyeScaleX = 1.2;
    } else {
        eyeScaleY = Math.max(0.1, 1 - blink * 0.9);
    }
    if (isProcessing) {
        eyeScaleX = 1.1;
    }

    useFrame((state, delta) => {
        const { isSpeaking, volume } = plutoAudioState;

        const now = Date.now();
        if (now > randomnessRef.current.until) {
            randomnessRef.current = {
                x: (Math.random() - 0.5) * 0.25,
                y: (Math.random() - 0.5) * 0.15,
                until: now + 1400 + Math.random() * 2200,
            };
        }

        let targetX = 0;
        let targetY = 0;

        if (!isOffline && !isProcessing) {
            if (isSpeaking) {
                targetX = 0;
                targetY = 0;
            } else if (avatarState === 'idle') {
                targetX = cursor.x + randomnessRef.current.x;
                targetY = cursor.y * 1.2 + randomnessRef.current.y;
            } else {
                targetX = cursor.x;
                targetY = cursor.y * 1.2;
            }
            targetX = Math.max(-1.3, Math.min(1.3, targetX));
            targetY = Math.max(-1.2, Math.min(1.2, targetY));
        }

        targetLook.current.set(targetX, targetY);

        let headBobX = 0;
        let headBobY = 0;
        if (isSpeaking) {
            headBobY =
                Math.sin(state.clock.elapsedTime * 6) *
                Math.min(0.5, volume) *
                0.3;
            headBobX =
                Math.cos(state.clock.elapsedTime * 4) *
                Math.min(0.5, volume) *
                0.15;
        }

        if (groupRef.current) {
            groupRef.current.rotation.order = 'YXZ';
            const TENSION = 420;
            const FRICTION = 41;

            const sy = springY.current;
            const ay =
                TENSION * (targetLook.current.x - sy.val) - FRICTION * sy.v;
            sy.v += ay * delta;
            sy.val += sy.v * delta;
            groupRef.current.rotation.y = sy.val + headBobX;

            const sx = springX.current;
            const ax =
                TENSION * (targetLook.current.y - sx.val) - FRICTION * sx.v;
            sx.v += ax * delta;
            sx.val += sx.v * delta;
            groupRef.current.rotation.x = sx.val + headBobY;
        }

        // Animate Eyes & Widen them when speaking
        const targetEyeWiden =
            isSpeaking && volume > 0.3 ? 1.0 + (volume - 0.3) * 0.5 : 1.0;
        if (animatedLeftEyeRef.current) {
            animatedLeftEyeRef.current.scale.lerp(
                new THREE.Vector3(
                    eyeScaleX * targetEyeWiden,
                    eyeScaleY * targetEyeWiden,
                    1,
                ),
                delta * 15,
            );
        }
        if (animatedRightEyeRef.current) {
            animatedRightEyeRef.current.scale.lerp(
                new THREE.Vector3(
                    eyeScaleX * targetEyeWiden,
                    eyeScaleY * targetEyeWiden,
                    1,
                ),
                delta * 15,
            );
        }

        // Animate Mouth
        if (animatedMouthRef.current) {
            const currentVolume = isSpeaking ? volume : 0;
            // Amplify volume for stronger mouth movement
            const mouthOpen = Math.min(1, currentVolume * 4.0);

            // At idle (not speaking) the mouth is at scale 1
            // When speaking, we squash width slightly and stretch height aggressively
            const targetMouthScale = new THREE.Vector3(
                1.0 - mouthOpen * 0.2,
                0.1 + mouthOpen * 1.5,
                0.5,
            );
            animatedMouthRef.current.scale.lerp(targetMouthScale, delta * 18);
        }
    });

    return (
        <group>
            {/* The main planet Pluto */}
            <Sphere args={[2, 64, 64]}>
                <meshStandardMaterial color={plutoColor} roughness={0.8} />
            </Sphere>

            {/* Rotatable Face Group (eyes and mouth) */}
            <group ref={groupRef}>
                {/* Left Eye */}
                {isOffline ? (
                    <mesh
                        position={[-0.7, 0.3, 1.95]}
                        rotation={[0, 0, Math.PI / 8]}>
                        <boxGeometry args={[0.5, 0.08, 0.1]} />
                        <meshBasicMaterial color="#EAEAEA" />
                    </mesh>
                ) : (
                    <Sphere
                        ref={animatedLeftEyeRef}
                        args={[0.22, 32, 32]}
                        position={[-0.7, 0.3, 1.9]}>
                        <meshBasicMaterial color="#FCF5F7" />
                    </Sphere>
                )}

                {/* Right Eye */}
                {isOffline ? (
                    <mesh
                        position={[0.7, 0.3, 1.95]}
                        rotation={[0, 0, -Math.PI / 8]}>
                        <boxGeometry args={[0.5, 0.08, 0.1]} />
                        <meshBasicMaterial color="#EAEAEA" />
                    </mesh>
                ) : (
                    <Sphere
                        ref={animatedRightEyeRef}
                        args={[0.22, 32, 32]}
                        position={[0.7, 0.3, 1.9]}>
                        <meshBasicMaterial color="#FCF5F7" />
                    </Sphere>
                )}

                {/* Mouth */}
                {isOffline ? (
                    <mesh
                        position={[0, -0.4, 1.95]}
                        rotation={[Math.PI / 8, 0, 0]}>
                        <torusGeometry args={[0.3, 0.06, 16, 32, Math.PI]} />
                        <meshBasicMaterial color="#EAEAEA" />
                    </mesh>
                ) : plutoAudioState.isSpeaking ||
                  (!isOffline && !isAlert && !isProcessing && !curious) ? (
                    // When speaking or regular idle, we show the animated mouth dot
                    <Sphere
                        ref={animatedMouthRef}
                        args={[0.2, 32, 32]}
                        position={[0, -0.4, 1.95]}>
                        <meshBasicMaterial color="#FCF5F7" />
                    </Sphere>
                ) : isAlert || curious ? (
                    <Sphere
                        args={[0.2, 32, 32]}
                        position={[0, -0.4, 1.95]}
                        scale={[1, 1.2, 0.5]}>
                        <meshBasicMaterial color="#FCF5F7" />
                    </Sphere>
                ) : (
                    <RoundedBox
                        args={[0.8, 0.15, 0.1]}
                        position={[0, -0.4, 1.95]}
                        radius={0.05}>
                        <meshBasicMaterial color="#FCF5F7" />
                    </RoundedBox>
                )}
            </group>
        </group>
    );
}

export function PlutoAvatar(props: PlutoAvatarProps) {
    return (
        <div
            style={{
                width: 220,
                height: 220,
                margin: '0 auto',
                pointerEvents: 'none',
            }}
            className="pet-canvas">
            <Canvas camera={{ position: [0, 0, 5], fov: 50 }}>
                <ambientLight intensity={0.7} />
                <directionalLight position={[5, 5, 5]} intensity={1.2} />
                <directionalLight position={[-5, 5, 2]} intensity={0.5} />
                <PlutoScene {...props} />
            </Canvas>
        </div>
    );
}
