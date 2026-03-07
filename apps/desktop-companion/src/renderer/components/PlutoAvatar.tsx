import { RoundedBox, Sphere } from '@react-three/drei';
import { Canvas, useFrame } from '@react-three/fiber';
import { useRef } from 'react';
import * as THREE from 'three';

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
    const targetLook = useRef(new THREE.Vector2());
    const randomnessRef = useRef({ x: 0, y: 0, until: 0 });
    const springX = useRef({ v: 0, val: 0 });
    const springY = useRef({ v: 0, val: 0 });

    useFrame((state, delta) => {
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

        if (avatarState !== 'offline' && !isProcessing) {
            // X ist jetzt direkt gemappt: Maus (+X) nach rechts dreht Modell nach rechts.
            // Y-Multiplier auf 1.3 erhöht, damit er viel weiter nach oben in den Himmel schauen kann.
            if (avatarState === 'idle') {
                targetX = cursor.x + randomnessRef.current.x;
                targetY = cursor.y * 1.3 + randomnessRef.current.y;
            } else {
                targetX = cursor.x;
                targetY = cursor.y * 1.3;
            }

            // Weite Limits setzen, damit Kopf weich in extreme Winkel (fast 90 Grad = 1.57) gehen kann
            targetX = Math.max(-1.3, Math.min(1.3, targetX));
            targetY = Math.max(-1.4, Math.min(1.2, targetY));
        }

        targetLook.current.set(targetX, targetY);

        if (groupRef.current) {
            // "YXZ" order prevents skewed/diagonal look (Roll/Gimbal lock) when looking up and left/right
            groupRef.current.rotation.order = 'YXZ';

            // Klothoide-artige Beschleunigung und weiche Dampfung wie nach einer Feder
            // Dadurch fuehlt es sich menschlicher an, kein hartes "Einrasten" am neuen frame
            // und keine harten Geschwindigkeitssprunge.
            const TENSION = 420;
            const FRICTION = 41;

            const sy = springY.current;
            const ay =
                TENSION * (targetLook.current.x - sy.val) - FRICTION * sy.v;
            sy.v += ay * delta;
            sy.val += sy.v * delta;
            groupRef.current.rotation.y = sy.val;

            const sx = springX.current;
            const ax =
                TENSION * (targetLook.current.y - sx.val) - FRICTION * sx.v;
            sx.v += ax * delta;
            sx.val += sx.v * delta;
            groupRef.current.rotation.x = sx.val;
        }
    });

    const isOffline = avatarState === 'offline';
    const isAlert = avatarState === 'alert';

    // A nice brownish/tan color characteristic for Pluto's surface
    // Offline it fades to a sleepy gray/blue
    const plutoColor = isOffline ? '#848C98' : '#D1A384';

    // Scale eyes based on blinking, curiosity or processing
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
                        args={[0.22, 32, 32]}
                        position={[-0.7, 0.3, 1.9]}
                        scale={[eyeScaleX, eyeScaleY, 1]}>
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
                        args={[0.22, 32, 32]}
                        position={[0.7, 0.3, 1.9]}
                        scale={[eyeScaleX, eyeScaleY, 1]}>
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
                ) : isAlert || curious ? (
                    <Sphere
                        args={[0.2, 32, 32]}
                        position={[0, -0.4, 1.95]}
                        scale={[1, 1.2, 0.5]}>
                        <meshBasicMaterial color="#FCF5F7" />
                    </Sphere>
                ) : isProcessing ? (
                    <RoundedBox
                        args={[0.8, 0.15, 0.1]}
                        position={[0, -0.4, 1.95]}
                        radius={0.05}>
                        <meshBasicMaterial color="#FCF5F7" />
                    </RoundedBox>
                ) : (
                    <mesh
                        position={[0, -0.3, 1.95]}
                        rotation={[-0.2, 0, Math.PI]}>
                        <torusGeometry args={[0.3, 0.06, 16, 32, Math.PI]} />
                        <meshBasicMaterial color="#FCF5F7" />
                    </mesh>
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
