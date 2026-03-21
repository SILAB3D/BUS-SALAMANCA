export interface StopOption {
  stopId: string
  stopName: string
  lat: number
  lon: number
  url: string
}

export interface RouteInsight {
  routeId: string
  shortName: string
  longName: string
  description: string
  routeColor: string
  routeTextColor: string
  tripCount: number
  headsigns: string[]
}

export interface RouteStop {
  stopId: string
  stopName: string
}

export interface RouteDirectionOption {
  key: string
  routeShortName: string
  headsign: string
  label: string
}

export interface DepartureInsight {
  stopId?: string
  tripId: string
  routeId: string
  routeShortName: string
  routeColor: string
  routeTextColor: string
  headsign: string
  arrivalTime: string
  departureTime: string
  minutesUntil: number | null
  scheduledTime?: string
  estimatedTime?: string
  delaySeconds?: number | null
  isRealtime?: boolean
}

export interface RealtimeSnapshot {
  providerName: string
  connected: boolean
  vehicleCount: number
  tripUpdateCount?: number
  updatedAt: string | null
  statusMessage: string
}

export interface FeedSummary {
  routes: number
  stops: number
  trips: number
  stopTimes: number
  serviceDates: number
}

export interface RealtimeNetworkMetadata {
  routes: RouteInsight[]
  stopOptions: StopOption[]
  routeDirectionOptions: RouteDirectionOption[]
  routeStopsByDirectionKey: Record<string, RouteStop[]>
}

export interface GtfsDataset {
  summary: FeedSummary
  routes: RouteInsight[]
  stopOptions: StopOption[]
  stopMap: Map<string, StopOption>
  getRouteDirectionOptions(): RouteDirectionOption[]
  findStops(query: string): StopOption[]
  getUpcomingDepartures(stopId: string, referenceDate: Date, limit?: number, routeId?: string): DepartureInsight[]
  getScheduledTimesByDayType(stopId: string, routeShortName: string, dayType: ServiceDayType, startHour: number, endHour: number): string[]
  getRouteStops(routeShortName: string, pivotStopId?: string, headsign?: string): RouteStop[]
}

export type ServiceDayType = 'weekday' | 'saturday' | 'sunday'