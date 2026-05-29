export const POSITIONS = ["BTN", "BB"] as const;

export const RFI: Record<string, string> = {
  BTN: [
    "22+",
    "A2s+,K2s+,Q2s+,J2s+",
    "T3s+,93s+,83s+,73s+,63s+,52s+,42s+,32s",
    "A2o+,K2o+",
    "Q4o+,J6o+,T6o+,96o+,85o+,75o+,64o+,54o",
  ].join(","),
};

export const BB_DEFENSE: Record<string, string> = {
  BTN: [
    "22+",
    "A2s+,K2s+,Q2s+,J3s+",
    "T4s+,94s+,84s+,73s+,63s+,53s+,43s,32s",
    "A2o+,K3o+",
    "Q5o+,J7o+,T7o+,96o+,86o+,76o,65o,54o",
  ].join(","),
};
