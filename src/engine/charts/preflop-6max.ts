export const POSITIONS = ["UTG", "MP", "CO", "BTN", "SB", "BB"] as const;

export const RFI: Record<string, string> = {
  UTG: "22+,A9s+,KTs+,QTs+,JTs,T9s,ATo+,KJo+",
  MP: "22+,A7s+,K9s+,Q9s+,J9s+,T9s,98s,87s,ATo+,KTo+,QJo",
  CO: "22+,A2s+,K6s+,Q8s+,J8s+,T8s+,97s+,87s,76s,65s,A8o+,KTo+,QTo+,JTo,T9o",
  BTN: "22+,A2s+,K3s+,Q6s+,J7s+,T7s+,97s+,86s+,76s,65s,54s,A2o+,K8o+,Q9o+,J9o+,T9o,98o",
  SB: "22+,A2s+,K4s+,Q7s+,J8s+,T7s+,97s+,86s+,76s,65s,54s,A4o+,KTo+,QTo+,JTo",
};

export const BB_DEFENSE: Record<string, string> = {
  UTG: "22+,A2s+,K7s+,Q9s+,J8s+,T8s+,97s+,87s,76s,65s,A5o+,KTo+,QTo+,JTo,T9o",
  MP: "22+,A2s+,K5s+,Q8s+,J8s+,T7s+,97s+,86s+,76s,65s,A3o+,K9o+,QTo+,JTo,T9o",
  CO: "22+,A2s+,K3s+,Q6s+,J7s+,T7s+,96s+,86s+,75s+,65s,54s,A2o+,K7o+,Q9o+,J9o+,T9o,98o",
  BTN: "22+,A2s+,K2s+,Q4s+,J6s+,T6s+,96s+,85s+,75s+,64s+,54s,43s,A2o+,K5o+,Q8o+,J8o+,T8o+,97o+,87o,76o,65o",
  SB: "22+,A2s+,K2s+,Q3s+,J5s+,T6s+,95s+,85s+,74s+,64s+,53s+,43s,A2o+,K5o+,Q8o+,J8o+,T8o+,97o+,87o,76o",
};
