// Preloaded into every test process (npm test --import): a developer's own
// PROTON_DRIVE_INDEX* settings must never make a test touch the real cache dir.
// The same goes for the encrypted content index (PROTON_DRIVE_CONTENT_INDEX*) and its keychain service name,
// and for OCR (PROTON_DRIVE_OCR*): it is opt-in and tests that expect "unsupported" must not see a developer's setting.
for (const k of Object.keys(process.env)) if (k.startsWith("PROTON_DRIVE_INDEX") || k.startsWith("PROTON_DRIVE_CONTENT_INDEX") || k.startsWith("PROTON_DRIVE_OCR") || k === "PROTON_DRIVE_KEYCHAIN_SERVICE") delete process.env[k];
