import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InstanceRealtime } from "../../../src/services/instanceRealtime";

const deferred = () => {
    let resolve!: (value?: any) => void;
    const promise = new Promise<any>((done) => {
        resolve = done;
    });
    return { promise, resolve };
};
describe("instance realtime ownership", () => {
    let service: InstanceRealtime;
    let sdk: any;
    let generation: number;
    let userId: string;
    let channels: Map<string, any>;
    const settle = async () => {
        for (let i = 0; i < 10; i++) await Promise.resolve();
    };
    beforeEach(() => {
        vi.useFakeTimers();
        Zotero.logError = vi.fn();
        generation = 1;
        userId = "a";
        channels = new Map();
        sdk = {
            auth: {
                getSession: vi
                    .fn()
                    .mockResolvedValue({
                        data: { session: { access_token: "token" } },
                    }),
            },
            realtime: { setAuth: vi.fn().mockResolvedValue(undefined) },
            channel: vi.fn((topic: string) => {
                if (channels.has(topic)) return channels.get(topic);
                const channel: any = {
                    on: vi.fn((_kind, _filter, callback) => {
                        channel.emit = callback;
                        return channel;
                    }),
                    subscribe: vi.fn(() => channel),
                };
                channels.set(topic, channel);
                return channel;
            }),
            removeChannel: vi.fn(async (channel) => {
                for (const [topic, value] of channels)
                    if (value === channel) channels.delete(topic);
            }),
        };
        service = new InstanceRealtime(sdk, sdk.auth, () => ({
            generation,
            userId,
        }));
    });
    afterEach(() => {
        service.clear();
        vi.useRealTimers();
    });
    it.each(["threads", "provider-wake"] as const)(
        "shares %s and keeps the survivor subscribed after either renderer closes",
        async (kind) => {
            const first = vi.fn();
            const second = vi.fn();
            const stopA = service.subscribe(kind, "a", first);
            const stopB = service.subscribe(kind, "a", second);
            await settle();
            expect(sdk.channel).toHaveBeenCalledTimes(1);
            const channel = [...channels.values()][0];
            channel.emit({
                eventType: "UPDATE",
                new: { id: "thread" },
                old: {},
            });
            expect(first).toHaveBeenCalledTimes(1);
            expect(second).toHaveBeenCalledTimes(1);
            stopA();
            stopA();
            channel.emit({
                eventType: "UPDATE",
                new: { id: "thread" },
                old: {},
            });
            expect(first).toHaveBeenCalledTimes(1);
            expect(second).toHaveBeenCalledTimes(2);
            expect(sdk.removeChannel).not.toHaveBeenCalled();
            stopB();
            expect(sdk.removeChannel).toHaveBeenCalledTimes(1);
            channel.emit({});
            expect(second).toHaveBeenCalledTimes(2);
        },
    );
    it("waits for SDK topic removal before reacquiring the last released channel", async () => {
        const stop = service.subscribe("threads", "a", vi.fn());
        await settle();
        const old = [...channels.values()][0];
        const removal = deferred();
        sdk.removeChannel.mockImplementationOnce(async () => {
            await removal.promise;
            channels.clear();
        });
        stop();
        const listener = vi.fn();
        service.subscribe("threads", "a", listener);
        await settle();
        expect(sdk.channel).toHaveBeenCalledTimes(1);
        old.emit({});
        expect(listener).not.toHaveBeenCalled();
        removal.resolve();
        await settle();
        expect(sdk.channel).toHaveBeenCalledTimes(2);
        [...channels.values()][0].emit({});
        expect(listener).toHaveBeenCalledTimes(1);
    });
    it("does not create a channel after its last listener detaches during auth", async () => {
        const auth = deferred();
        sdk.auth.getSession.mockReturnValueOnce(auth.promise);
        const stop = service.subscribe("provider-wake", "a", vi.fn());
        await settle();
        stop();
        auth.resolve({ data: { session: { access_token: "old" } } });
        await settle();
        expect(sdk.realtime.setAuth).not.toHaveBeenCalled();
        expect(sdk.channel).not.toHaveBeenCalled();
    });
    it("invalidates old events and pending auth on account replacement", async () => {
        const listener = vi.fn();
        service.subscribe("threads", "a", listener);
        await settle();
        const old = [...channels.values()][0];
        const auth = deferred();
        sdk.auth.getSession.mockReturnValueOnce(auth.promise);
        service.subscribe("provider-wake", "a", listener);
        await settle();
        service.clear();
        generation++;
        userId = "b";
        auth.resolve({ data: { session: { access_token: "old" } } });
        await settle();
        old.emit({});
        expect(listener).not.toHaveBeenCalled();
        expect(sdk.realtime.setAuth).not.toHaveBeenCalled();
        expect(sdk.channel).toHaveBeenCalledTimes(1);
    });
    it("retries transient credential failures once for all listeners and cancels retries on release", async () => {
        sdk.auth.getSession.mockRejectedValue(new Error("offline"));
        const a = service.subscribe("provider-wake", "a", vi.fn());
        const b = service.subscribe("provider-wake", "a", vi.fn());
        await settle();
        expect(sdk.auth.getSession).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(5000);
        expect(sdk.auth.getSession).toHaveBeenCalledTimes(2);
        a();
        b();
        await vi.advanceTimersByTimeAsync(10000);
        expect(sdk.auth.getSession).toHaveBeenCalledTimes(2);
    });
});
