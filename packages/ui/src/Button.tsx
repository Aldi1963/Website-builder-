import type { ButtonHTMLAttributes, PropsWithChildren } from "react";
import { cn } from "./utils";

export function Button({ className, children, ...props }: PropsWithChildren<ButtonHTMLAttributes<HTMLButtonElement>> & { className?: string }) {
  return <button className={cn("wb-ui-button", className)} {...props}>{children}</button>;
}
