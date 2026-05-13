// Set env vars before any src/ module is loaded so BASE_URL and HASHED_PASSWORD
// are computed with non-empty values in every test file.
process.env.OS_HOST = 'opensprinkler.test';
process.env.OS_PASSWORD = 'testpassword';
