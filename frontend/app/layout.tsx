import type { ReactNode } from 'react';
import './style.css';
export const metadata = { title: 'AI Voice Chatbot', description: 'Text and voice AI assistant' };
export default function RootLayout({children}:{children:ReactNode}) { return <html lang="en"><body>{children}</body></html>; }
