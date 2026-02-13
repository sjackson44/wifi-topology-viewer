#import <Foundation/Foundation.h>
#import <CoreWLAN/CoreWLAN.h>

static NSString *detectSecurity(CWNetwork *network) {
  if ([network supportsSecurity:kCWSecurityWPA3Enterprise]) {
    return @"WPA3-ENT";
  }
  if ([network supportsSecurity:kCWSecurityWPA3Personal]) {
    return @"WPA3";
  }
  if ([network supportsSecurity:kCWSecurityWPA3Transition]) {
    return @"WPA3-TRANSITION";
  }
  if ([network supportsSecurity:kCWSecurityOWETransition]) {
    return @"OWE-TRANSITION";
  }
  if ([network supportsSecurity:kCWSecurityOWE]) {
    return @"OWE";
  }
  if ([network supportsSecurity:kCWSecurityWPA2Enterprise]) {
    return @"WPA2-ENT";
  }
  if ([network supportsSecurity:kCWSecurityWPA2Personal]) {
    return @"WPA2";
  }
  if ([network supportsSecurity:kCWSecurityWPAPersonalMixed]) {
    return @"WPA/WPA2";
  }
  if ([network supportsSecurity:kCWSecurityWPAPersonal]) {
    return @"WPA";
  }
  if ([network supportsSecurity:kCWSecurityDynamicWEP]) {
    return @"DYNAMIC-WEP";
  }
  if ([network supportsSecurity:kCWSecurityWEP]) {
    return @"WEP";
  }
  if ([network supportsSecurity:kCWSecurityNone]) {
    return @"NONE";
  }

  return @"UNKNOWN";
}

int main(void) {
  @autoreleasepool {
    CWWiFiClient *client = [CWWiFiClient sharedWiFiClient];
    CWInterface *iface = [client interface];

    if (iface == nil) {
      fprintf(stderr, "{\"error\":\"no-interface\"}\n");
      return 2;
    }

    NSError *scanError = nil;
    NSSet<CWNetwork *> *networks = [iface scanForNetworksWithSSID:nil error:&scanError];
    if (scanError != nil) {
      NSString *msg = [scanError.localizedDescription stringByReplacingOccurrencesOfString:@"\"" withString:@"'"];
      fprintf(stderr, "{\"error\":\"%s\"}\n", msg.UTF8String);
      return 3;
    }

    NSMutableArray *rows = [NSMutableArray arrayWithCapacity:networks.count];

    for (CWNetwork *network in networks) {
      NSString *ssid = network.ssid ?: @"";
      NSString *bssid = network.bssid ?: @"";
      NSNumber *rssi = @(network.rssiValue);
      NSNumber *noise = @(network.noiseMeasurement);
      NSNumber *channel = @(network.wlanChannel.channelNumber);
      NSString *security = detectSecurity(network);

      [rows addObject:@{
        @"ssid": ssid,
        @"bssid": bssid,
        @"rssi": rssi,
        @"noise": noise,
        @"channel": channel,
        @"security": security,
      }];
    }

    NSError *jsonError = nil;
    NSData *json = [NSJSONSerialization dataWithJSONObject:rows options:0 error:&jsonError];
    if (jsonError != nil || json == nil) {
      fprintf(stderr, "{\"error\":\"json-encode-failed\"}\n");
      return 4;
    }

    NSString *output = [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding];
    printf("%s\n", output.UTF8String);
    return 0;
  }
}
