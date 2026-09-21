"use client";

import {useEffect, useMemo, useState} from "react";

type FreeSlot = {
  providerId: string;
  providerName: string;
  serviceId: string;
  startISO: string;
  endISO: string;
  label: string;
  mode: string;
};

type BookingResult = {
  booking: {id: string; serviceName: string; date: string; mode: string; credits: number; packageName?: string; packageItem?: string};
  provider?: {id: string; name: string};
};

type BookingFlowProps = {
  serviceId: string;
  serviceName?: string;
  mode?: string;
  initialProviderId?: string;
  packageName?: string;
  packageItem?: string;
  onBooked?: (result: BookingResult) => void;
};

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function dayKeyOf(iso: string): string {
  return iso.slice(0, 10);
}

function dayLabel(iso: string): string {
  const date = new Date(iso);
  return `${DAY_LABELS[date.getDay()]} ${MONTH_LABELS[date.getMonth()]} ${date.getDate()}`;
}

/**
 * Member booking flow: pick a provider (or let Salu assign), pick a free
 * slot, confirm. Not mounted anywhere by default — the coordinator wires it
 * into the booking surface.
 */
export function BookingFlow({serviceId, serviceName, mode, initialProviderId, packageName, packageItem, onBooked}: BookingFlowProps) {
  const [slots, setSlots] = useState<FreeSlot[]>([]);
  const [loading, setLoading] = useState(true);
  const [providerId, setProviderId] = useState<string>(initialProviderId ?? "auto");
  const [dayKey, setDayKey] = useState("");
  const [slotStart, setSlotStart] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<BookingResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    const now = new Date();
    const params = new URLSearchParams({
      serviceId,
      from: now.toISOString(),
      to: new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString(),
    });
    fetch(`/api/providers/slots?${params.toString()}`)
      .then((res) => res.json() as Promise<{slots?: FreeSlot[]; error?: string}>)
      .then((data) => {
        if (cancelled) return;
        if (data.error) {
          setError(data.error);
          return;
        }
        setSlots(data.slots ?? []);
      })
      .catch(() => {
        if (!cancelled) setError("Free times could not be loaded just now.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [serviceId]);

  const providers = useMemo(() => {
    const map = new Map<string, string>();
    for (const slot of slots) map.set(slot.providerId, slot.providerName);
    return [...map.entries()].map(([id, name]) => ({id, name}));
  }, [slots]);

  const filtered = useMemo(
    () => (providerId === "auto" ? slots : slots.filter((slot) => slot.providerId === providerId)),
    [slots, providerId],
  );
  const days = useMemo(() => {
    const keys = [...new Set(filtered.map((slot) => dayKeyOf(slot.startISO)))].sort();
    return keys;
  }, [filtered]);
  const daySlots = useMemo(
    () => filtered.filter((slot) => dayKeyOf(slot.startISO) === dayKey),
    [filtered, dayKey],
  );

  const pickDay = (key: string) => {
    setDayKey(key);
    setSlotStart("");
  };

  const confirm = async () => {
    if (!slotStart) return;
    setBusy(true);
    setError("");
    try {
      if (providerId === "auto") {
        const res = await fetch("/api/bookings/assign", {
          method: "POST",
          headers: {"Content-Type": "application/json"},
          body: JSON.stringify({serviceId, startISO: slotStart, mode, packageName, packageItem}),
        });
        const data = await res.json() as {error?: string; booking?: BookingResult["booking"]; provider?: {id: string; name: string}};
        if (!res.ok || data.error || !data.booking) {
          setError(data.error ?? "That time could not be booked.");
          return;
        }
        const result = {booking: data.booking, provider: data.provider};
        setDone(result);
        onBooked?.(result);
        return;
      }
      const res = await fetch("/api/bookings", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({serviceId, mode, providerId, slotStart, packageName, packageItem}),
      });
      const data = await res.json() as {error?: string; booking?: BookingResult["booking"]; provider?: {id: string; name: string}};
      if (!res.ok || data.error || !data.booking) {
        setError(data.error ?? "That time could not be booked.");
        return;
      }
      const result = {booking: data.booking, provider: data.provider};
      setDone(result);
      onBooked?.(result);
    } catch {
      setError("That time could not be booked just now.");
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <p className="request-empty">Loading free times…</p>;
  if (done) {
    return (
      <section className="portal-card">
        <div className="section-title">
          <span className="eyebrow">BOOKED</span>
          <h2>You are on the calendar.</h2>
        </div>
        <div className="request-card">
          <div>
            <small>{done.booking.date}</small>
            <h3>{done.booking.serviceName}</h3>
            <p>{done.provider?.name ?? ""} · {done.booking.mode} · {done.booking.credits} credits</p>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="portal-card">
      <div className="section-title">
        <span className="eyebrow">BOOK{serviceName ? ` · ${serviceName.toUpperCase()}` : ""}</span>
        <h2>Pick a time that works.</h2>
      </div>

      <label>
        Provider
        <select value={providerId} onChange={(event) => {setProviderId(event.target.value); setDayKey(""); setSlotStart("");}}>
          <option value="auto">Best available — let Salu pick</option>
          {providers.map((provider) => (
            <option key={provider.id} value={provider.id}>{provider.name}</option>
          ))}
        </select>
      </label>

      {!filtered.length && !error && <p className="request-empty">No free times in the next 14 days.</p>}

      {days.length > 0 && (
        <>
          <div className="chip-row">
            {days.map((key) => (
              <button
                key={key}
                type="button"
                className={key === dayKey ? "active" : ""}
                onClick={() => pickDay(key)}
              >
                {dayLabel(filtered.find((slot) => dayKeyOf(slot.startISO) === key)!.startISO)}
              </button>
            ))}
          </div>
          {dayKey && (
            <div className="chip-row">
              {daySlots.map((slot) => (
                <button
                  key={slot.startISO + slot.providerId}
                  type="button"
                  className={slot.startISO === slotStart ? "active" : ""}
                  onClick={() => setSlotStart(slot.startISO)}
                >
                  {slot.label.split("·")[1]?.trim() ?? slot.label}
                  {providerId === "auto" && ` · ${slot.providerName}`}
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {error && <p className="form-error">{error}</p>}

      <button type="button" disabled={busy || !slotStart} onClick={() => void confirm()}>
        {busy ? "Booking…" : "Confirm booking"}
      </button>
    </section>
  );
}
