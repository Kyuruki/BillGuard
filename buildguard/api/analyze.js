import formidable from "formidable";
import fs from "fs";

export default async function handler(req, res) {
  const form = formidable();
  form.parse(req, (err, fields, files) => {
    if (err) {
      return res.status(500).json({ error: "Failed to parse file" });
    }
    const filepath = files.file[0].filepath;
    console.log(filepath);

    return res.status(200).json({ status: "ok", filepath: filepath });
  });
}
