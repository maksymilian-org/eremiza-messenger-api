export const waitForTimeout = (milliseconds) =>
  new Promise((r) => setTimeout(r, milliseconds));

const convertToDecimal = (degrees, minutes, seconds, direction) => {
  let decimalValue = degrees + minutes / 60 + seconds / 3600;
  if (direction === "S" || direction === "W") {
    decimalValue = -decimalValue;
  }
  // Rounding the value to 6 decimal places
  return decimalValue.toFixed(6);
};

export const convertCoorsFromERemizaToDecimal = (inputString) => {
  // Regular expression to match latitude and longitude values
  const regex =
    /\s*(\d+)°\s+(\d+)'\s+([\d,]+)"([EW])\s+\|\s+(\d+)°\s+(\d+)'\s+([\d,]+)"([NS])/;

  // Using the exec method on the string to match the values using the regular expression
  let match = regex.exec(inputString);

  let longitude, latitude;

  // Checking if the match was successful
  if (match) {
    // Converting values to appropriate types and assigning them to variables
    const degreesLongitude = parseInt(match[1], 10);
    const minutesLongitude = parseInt(match[2], 10);
    const secondsLongitude = parseFloat(match[3].replace(",", "."));
    const directionLongitude = match[4];

    const degreesLatitude = parseInt(match[5], 10);
    const minutesLatitude = parseInt(match[6], 10);
    const secondsLatitude = parseFloat(match[7].replace(",", "."));
    const directionLatitude = match[8];

    // Converting to decimal format
    if (directionLongitude === "E" || directionLongitude === "W") {
      longitude = convertToDecimal(
        degreesLongitude,
        minutesLongitude,
        secondsLongitude,
        directionLongitude
      );
    }

    if (directionLatitude === "N" || directionLatitude === "S") {
      latitude = convertToDecimal(
        degreesLatitude,
        minutesLatitude,
        secondsLatitude,
        directionLatitude
      );
    }
  } else {
    console.log("Failed to match coordinates.");
  }

  return [Number(latitude), Number(longitude)];
};
