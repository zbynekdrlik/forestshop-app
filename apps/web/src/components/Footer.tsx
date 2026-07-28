import { useEffect, useState, type JSX } from "react";
import { fetchVersion } from "../api.js";

export function Footer(): JSX.Element {
  const [version, setVersion] = useState<string>("");
  useEffect(() => {
    void fetchVersion().then((v) => { setVersion(v.version); });
  }, []);
  return (
    <footer data-testid="version">{version === "" ? "" : `v${version}`}</footer>
  );
}
