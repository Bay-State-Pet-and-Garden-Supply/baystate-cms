async function checkAccount() {
  const apiKey = process.env.BRIGHT_DATA_API_KEY;
  if (!apiKey) return;

  // Check datasets API
  const dsRes = await fetch('https://api.brightdata.com/datasets/v3/snapshots', {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  console.log('Datasets Status:', dsRes.status);
  if (dsRes.ok) {
    const snapshots = await dsRes.json();
    console.log('Snapshots:', JSON.stringify(snapshots, null, 2));
  } else {
    const text = await dsRes.text();
    console.log('Datasets Response:', text);
  }

  // Check web scrapers / collector API
  const colRes = await fetch('https://api.brightdata.com/dca/get_collectors', {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  console.log('Collectors Status:', colRes.status);
  if (colRes.ok) {
    const collectors = await colRes.json();
    console.log('Collectors:', JSON.stringify(collectors, null, 2));
  }
}

checkAccount().catch(console.error);
