import type { MobilePairingCodeCreateOutput } from '@agent-companion/shared';
import QRCode from 'qrcode';
import { useEffect, useMemo, useState } from 'react';
import { Badge } from './ui/badge.js';
import { Button } from './ui/button.js';
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from './ui/card.js';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from './ui/dialog.js';

type MobilePairingCardProps = Readonly<{
    apiBase: string;
    desktopToken?: string;
}>;

export function MobilePairingCard({
    apiBase,
    desktopToken,
}: MobilePairingCardProps) {
    const [isGenerating, setIsGenerating] = useState(false);
    const [pairing, setPairing] =
        useState<MobilePairingCodeCreateOutput | null>(null);
    const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);

    const qrValue = useMemo(
        () => pairing?.pairingUrl ?? null,
        [pairing?.pairingUrl],
    );

    useEffect(() => {
        if (!qrValue) {
            setQrDataUrl(null);
            return;
        }

        let cancelled = false;
        QRCode.toDataURL(qrValue, {
            margin: 1,
            width: 320,
            color: {
                dark: '#F8FAFC',
                light: '#0F172ACC',
            },
        })
            .then((value: string) => {
                if (!cancelled) {
                    setQrDataUrl(value);
                }
            })
            .catch((nextError: unknown) => {
                if (!cancelled) {
                    setError(
                        nextError instanceof Error
                            ? nextError.message
                            : 'QR code generation failed',
                    );
                }
            });

        return () => {
            cancelled = true;
        };
    }, [qrValue]);

    return (
        <>
            <Card className="md:col-span-1">
                <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium text-slate-400">
                        Mobile Pairing
                    </CardTitle>
                    <CardDescription>
                        Generate a QR code so the iPhone app can scan server URL
                        and pairing code in one shot.
                    </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-4">
                    <div className="flex flex-wrap gap-2">
                        {pairing?.serverBaseUrl ? (
                            <Badge
                                variant="secondary"
                                className="border-white/10 bg-black/40 text-slate-300">
                                {truncate(pairing.serverBaseUrl, 34)}
                            </Badge>
                        ) : (
                            <Badge
                                variant="secondary"
                                className="border-amber-400/20 bg-amber-500/10 text-amber-200">
                                No reachable server URL detected yet
                            </Badge>
                        )}
                    </div>

                    <Button
                        size="sm"
                        onClick={() => void generatePairingCode()}
                        disabled={isGenerating}>
                        {isGenerating ? 'Generating…' : 'Show pairing QR'}
                    </Button>

                    <p className="text-xs leading-6 text-slate-400">
                        Scan the QR with the Pluto iPhone app. If no usable URL
                        is detected, the QR will not be shown and you can still
                        use the code manually.
                    </p>

                    {error ? (
                        <div className="rounded-2xl border border-rose-400/20 bg-rose-500/10 p-3 text-xs text-rose-100">
                            {error}
                        </div>
                    ) : null}
                </CardContent>
            </Card>

            <Dialog
                open={Boolean(pairing)}
                onOpenChange={(open) => {
                    if (!open) {
                        setPairing(null);
                        setCopied(false);
                    }
                }}>
                <DialogContent className="w-[min(720px,calc(100vw-32px))]">
                    <DialogHeader>
                        <DialogTitle>Pair Pluto on iPhone</DialogTitle>
                        <DialogDescription>
                            Open the Pluto iPhone app, tap QR scan, and point it
                            at this code.
                        </DialogDescription>
                    </DialogHeader>

                    <div className="mt-6 grid gap-6 md:grid-cols-[320px_minmax(0,1fr)]">
                        <div className="flex items-center justify-center rounded-[28px] border border-white/10 bg-black/30 p-4">
                            {qrDataUrl ? (
                                <img
                                    src={qrDataUrl}
                                    alt="Mobile pairing QR code"
                                    className="h-72 w-72 rounded-2xl"
                                />
                            ) : (
                                <div className="flex h-72 w-72 items-center justify-center rounded-2xl border border-dashed border-white/10 text-sm text-slate-500">
                                    QR code unavailable
                                </div>
                            )}
                        </div>

                        <div className="flex flex-col gap-4">
                            <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
                                <div className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                                    Pairing code
                                </div>
                                <div className="mt-2 text-3xl font-semibold tracking-[0.3em] text-white">
                                    {pairing?.code ?? '--------'}
                                </div>
                            </div>

                            <div className="rounded-2xl border border-white/10 bg-black/20 p-4 text-sm text-slate-300">
                                <div className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                                    Preferred server URL
                                </div>
                                <div className="mt-2 break-all font-mono text-xs leading-6 text-slate-200">
                                    {pairing?.serverBaseUrl ??
                                        'No reachable URL detected. Start the tunnel or use your laptop LAN address manually in the iPhone app.'}
                                </div>
                            </div>

                            {pairing?.serverBaseUrls.length ? (
                                <div className="rounded-2xl border border-white/10 bg-black/20 p-4 text-sm text-slate-300">
                                    <div className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                                        Other candidate URLs
                                    </div>
                                    <ul className="mt-2 space-y-1 font-mono text-xs leading-6 text-slate-300">
                                        {pairing.serverBaseUrls.map((entry) => (
                                            <li key={entry}>{entry}</li>
                                        ))}
                                    </ul>
                                </div>
                            ) : null}

                            <div className="flex flex-wrap gap-3">
                                <Button
                                    variant="secondary"
                                    onClick={() => void copyCode()}>
                                    {copied ? 'Copied' : 'Copy code'}
                                </Button>
                            </div>
                        </div>
                    </div>
                </DialogContent>
            </Dialog>
        </>
    );

    async function generatePairingCode() {
        try {
            setIsGenerating(true);
            setError(null);
            setCopied(false);

            const headers: Record<string, string> = {};
            if (desktopToken && apiBase === '/api/desktop') {
                headers['x-desktop-token'] = desktopToken;
            }

            const response = await fetch(`${apiBase}/mobile/pairing-code`, {
                method: 'POST',
                credentials: 'include',
                headers,
            });
            const payload = (await response.json().catch(() => null)) as
                | MobilePairingCodeCreateOutput
                | { message?: string }
                | null;

            if (!response.ok) {
                throw new Error(
                    payload && 'message' in payload && payload.message
                        ? payload.message
                        : `Pairing request failed with status ${response.status}`,
                );
            }

            setPairing(payload as MobilePairingCodeCreateOutput);
        } catch (nextError) {
            setError(
                nextError instanceof Error
                    ? nextError.message
                    : 'Pairing request failed',
            );
        } finally {
            setIsGenerating(false);
        }
    }

    async function copyCode() {
        if (!pairing?.code) {
            return;
        }
        await navigator.clipboard.writeText(pairing.code);
        setCopied(true);
        globalThis.setTimeout(() => setCopied(false), 1500);
    }
}

function truncate(value: string, maxLength: number) {
    if (value.length <= maxLength) {
        return value;
    }
    return `${value.slice(0, maxLength - 1)}…`;
}
