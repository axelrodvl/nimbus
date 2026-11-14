import { createContext, useContext } from 'react';

const ScrollContainerContext = createContext<HTMLElement | null>(null);

/** Общий прокручиваемый контейнер оболочки (`<main>`): виртуальные списки слушают прокрутку именно его. */
export const ScrollContainerProvider = ScrollContainerContext.Provider;

export const useScrollElement = (): HTMLElement | null => useContext(ScrollContainerContext);
