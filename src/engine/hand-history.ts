import { type Card } from "./cards.js";
import { type Action } from "./game-state.js";

export interface HandRecord {
  id: number;
  timestamp: number;
  tableSize: number;
  heroSeat: number;
  heroCards: [Card, Card];
  boardCards: Card[];
  actions: Action[];
  pot: number;
  result: string;
  heroPnl: number;
  bbValue: number;
  sbValue: number;
  dealerSeat: number;
}

export interface SessionStats {
  hands: number;
  totalPnl: number;
  wins: number;
  losses: number;
  biggestWin: number;
  biggestLoss: number;
  pnlHistory: number[];
}

const DB_NAME = "MonteCarloEdge";
const DB_VERSION = 1;
const STORE = "hands";

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
        store.createIndex("timestamp", "timestamp");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveHand(hand: Omit<HandRecord, "id">): Promise<number> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const req = store.add(hand);
    req.onsuccess = () => resolve(req.result as number);
    req.onerror = () => reject(req.error);
  });
}

export async function getSessionHands(since?: number): Promise<HandRecord[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const store = tx.objectStore(STORE);
    const req = store.getAll();
    req.onsuccess = () => {
      let hands = req.result as HandRecord[];
      if (since) hands = hands.filter(h => h.timestamp >= since);
      hands.sort((a, b) => a.timestamp - b.timestamp);
      resolve(hands);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function clearHistory(): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const req = store.clear();
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export function computeStats(hands: HandRecord[]): SessionStats {
  let totalPnl = 0;
  let wins = 0;
  let losses = 0;
  let biggestWin = 0;
  let biggestLoss = 0;
  const pnlHistory: number[] = [];

  for (const h of hands) {
    totalPnl += h.heroPnl;
    pnlHistory.push(totalPnl);
    if (h.heroPnl > 0) {
      wins++;
      biggestWin = Math.max(biggestWin, h.heroPnl);
    } else if (h.heroPnl < 0) {
      losses++;
      biggestLoss = Math.min(biggestLoss, h.heroPnl);
    }
  }

  return { hands: hands.length, totalPnl, wins, losses, biggestWin, biggestLoss, pnlHistory };
}
