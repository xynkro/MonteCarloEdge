import { describe, it, expect } from "vitest";
import { parseCard as P } from "../cards.js";
import { GameState } from "../game-state.js";
import { commitStory, scoreRunout, villainStoryNote, TAG, STATION, MANIAC } from "../opponent.js";

function gsWith(board: string[], street: "flop" | "turn" | "river" = "flop"): GameState {
  const gs = new GameState({
    tableSize: 6, bb: 2, stacks: Array(6).fill(200),
    positions: ["UTG","MP","CO","BTN","SB","BB"], heroSeat: 5,
    heroCards: [P("2c"), P("7d")], dealerSeat: 3,
  });
  gs.board = board.map(P);
  gs.street = street;
  return gs;
}

describe("villain story engine", () => {
  it("villainStories is empty on a fresh hand (per-hand by construction)", () => {
    const gs = gsWith([], "flop");
    expect(gs.villainStories.size).toBe(0);
  });

  it("commits a FLUSH rep on a two-tone board, carrying the profile coherence", () => {
    const gs = gsWith(["Ah", "9h", "2c"]); // two hearts
    const s = commitStory(gs, TAG);
    expect(s.rep).toBe("flush");
    expect(s.coherence).toBe(0.85);
    expect(s.openedStreet).toBe("flop");
  });

  it("dry rainbow board → MERGED top-pair rep (not a set); a small bet can't rep a monster", () => {
    const gs = gsWith(["Ah", "8c", "2d"]); // rainbow, disconnected, unpaired
    const s = commitStory(gs, TAG);
    expect(s.rep).toBe("pair_plus");
    expect(s.label).toMatch(/top pair|overpair/i);
  });

  it("PAIRED board → full-house rep (polarized — bet big to sell it)", () => {
    const gs = gsWith(["8h", "8c", "2d"]); // paired
    const s = commitStory(gs, TAG);
    expect(s.rep).toBe("trips_plus");
    expect(s.label).toMatch(/full house/i);
  });

  it("scoreRunout: flush rep SCARES when the suit completes, BRICKS otherwise, KILLS when paired", () => {
    const flop = gsWith(["Ah", "9h", "2c"]);
    const story = commitStory(flop, TAG); // flush rep on hearts
    expect(scoreRunout(story, [P("Ah"), P("9h"), P("2c"), P("5h")])).toBe("scare"); // 3rd heart
    expect(scoreRunout(story, [P("Ah"), P("9h"), P("2c"), P("5d")])).toBe("brick"); // blank
    expect(scoreRunout(story, [P("Ah"), P("9h"), P("2c"), P("2s")])).toBe("kill");  // paired → boat
  });

  it("coherence ranks TAG > MANIAC > STATION (story credibility)", () => {
    expect(TAG.coherence).toBeGreaterThan(MANIAC.coherence);
    expect(MANIAC.coherence).toBeGreaterThan(STATION.coherence);
    expect(STATION.coherence).toBe(0);
  });

  it("villainStoryNote reads the runout for the UI", () => {
    const flop = gsWith(["Ah", "9h", "2c"]);
    const story = commitStory(flop, TAG);
    expect(villainStoryNote(story, [P("Ah"),P("9h"),P("2c"),P("5h")])).toMatch(/flush/i);
  });
});
