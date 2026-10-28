// QA AI OS: runs before every test file.
import '@testing-library/jest-dom/vitest'; // toBeInTheDocument() and friends
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// Unmount what each test rendered, so one test's screen never leaks into the next.
afterEach(() => cleanup());
