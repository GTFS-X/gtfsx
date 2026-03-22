import type { StateCreator } from 'zustand';
import type { ValidationMessage } from '../types/ui';

export interface ValidationSlice {
  validationMessages: ValidationMessage[];
  isValidating: boolean;
  setValidationMessages: (messages: ValidationMessage[]) => void;
  clearValidationMessages: () => void;
  setIsValidating: (v: boolean) => void;
}

export const createValidationSlice: StateCreator<ValidationSlice, [['zustand/immer', never]], [], ValidationSlice> = (set) => ({
  validationMessages: [],
  isValidating: false,
  setValidationMessages: (messages) => set((state) => { state.validationMessages = messages; }),
  clearValidationMessages: () => set((state) => { state.validationMessages = []; }),
  setIsValidating: (v) => set((state) => { state.isValidating = v; }),
});
