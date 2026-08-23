import { Route, Routes } from 'react-router';
import { AppShell } from './components/layout/AppShell';
import { MeetingPage } from './pages/MeetingPage';
import { MeetingsPage } from './pages/MeetingsPage';

export function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<MeetingsPage />} />
        <Route path="meetings/:id" element={<MeetingPage />} />
        <Route path="*" element={<MeetingsPage />} />
      </Route>
    </Routes>
  );
}
