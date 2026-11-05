import { createContext, useContext, type CSSProperties } from "react";

export type ColoredUser = { name: string; uid?: string | null };
export type UserColors = Record<string, string>;
export const ColorContext = createContext<UserColors>({});
// Světlé plochy a tmavé iniciály: i nejtmavší vzorek má kontrast přes 4,5:1.
export const userPalette = Array.from(
  { length: 12 },
  (_, i) => `hsl(${i * 30} 65% 72%)`,
);
export function colorKey(user: ColoredUser) {
  return user.uid || `name:${user.name}`;
}
export function userColor(user: ColoredUser, colors: UserColors): string {
  const chosen = colors[colorKey(user)];
  if (userPalette.includes(chosen)) return chosen;
  const hash = [...(user.uid || user.name)].reduce(
    (n, c) => (n * 31 + c.charCodeAt(0)) >>> 0,
    0,
  );
  return `hsl(${hash % 360} 65% 72%)`;
}
export function Avatar({
  client,
  talking = false,
  className = "",
  onClick,
}: {
  client: ColoredUser;
  talking?: boolean;
  className?: string;
  onClick?: () => void;
}) {
  const colors = useContext(ColorContext);
  const style: CSSProperties = {
    background: userColor(client, colors),
    color: "#152016",
  };
  return (
    <span
      className={`avatar ${talking ? "speaking" : ""} ${className}`}
      style={style}
      onClick={onClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      aria-label={onClick ? `Uživatel ${client.name}` : undefined}
      aria-hidden={onClick ? undefined : true}
      onKeyDown={
        onClick
          ? (event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onClick();
              }
            }
          : undefined
      }
    >
      {client.name.slice(0, 2).toLocaleUpperCase("cs")}
    </span>
  );
}
