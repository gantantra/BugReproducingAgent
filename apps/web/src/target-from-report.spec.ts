import { describe, it, expect } from "vitest";
import { targetFromReport } from "./target.js";

/**
 * Taking the site from the report instead of asking the operator to repeat it.
 *
 * The page used to show a card asking for the base URL — already in the report — and then for an
 * environment label that changed nothing the run does. These pin that the address in the report is
 * enough, and that the page only asks when there genuinely is none.
 */

describe("the target named in the report", () => {
  it("takes the site from a real report instead of asking for it again", () => {
    // The report as it was actually sent, URL in parentheses and followed by a comma.
    const target = targetFromReport(
      "I was logged into 99acres on mobile web, then I attempted deleting my account from edit profile page (https://www.99acres.com/profile/editProfile), and no success msg or error msg of any type of showed up"
    );
    expect(target).toEqual({
      name: "99acres-com",
      baseUrl: "https://www.99acres.com",
      classification: "test",
    });
  });

  it("keeps only the origin, port included", () => {
    expect(
      targetFromReport("breaks at http://localhost:3000/app/cart?item=4 every few tries")
    ).toEqual({
      name: "localhost",
      baseUrl: "http://localhost:3000",
      classification: "test",
    });
  });

  it("uses the first address when the report mentions several", () => {
    const target = targetFromReport(
      "Checkout at https://shop.example.com/cart fails; the console shows https://cdn.example.net/app.js erroring."
    );
    expect(target?.baseUrl).toBe("https://shop.example.com");
    expect(target?.name).toBe("shop-example-com");
  });

  it("is null when the report names no web address, so the page asks for one", () => {
    expect(targetFromReport("Search sometimes returns nothing for a valid term.")).toBeNull();
    expect(targetFromReport("files are on ftp://files.example.com")).toBeNull();
    expect(targetFromReport("")).toBeNull();
  });
});
