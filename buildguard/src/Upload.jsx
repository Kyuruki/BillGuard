import { useState } from "react";

export default function Upload() {
  const [file, setFile] = useState(null);

  const handleAnalyze = async () => {
    if (!file) return;

    const formData = new FormData();
    formData.append("file", file);
    const response = await fetch("/api/analyze", {
      method: "POST",
      body: formData,
    });
    const data = await response.json();
    console.log(data);
  };
  return (
    <div>
      <h1>BillGuard</h1>
      <input
        type="file"
        accept="image/*,.pdf"
        onChange={(e) => setFile(e.target.files[0])}
      />
      <button>Upload</button>

      {file && <p>Selected: {file.name}</p>}
      <button onClick={handleAnalyze}>Analyze</button>
    </div>
  );
}
