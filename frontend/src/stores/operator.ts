import { create } from "zustand";

type OperatorState = {
  selectedIntervention: string | null;
  setSelectedIntervention: (id: string | null) => void;
};

export const useOperatorStore = create<OperatorState>((set) => ({
  selectedIntervention: null,
  setSelectedIntervention: (selectedIntervention) => set({ selectedIntervention }),
}));

